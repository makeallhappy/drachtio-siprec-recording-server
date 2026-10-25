# rtpengine 网络与 `--interface` 生产化方案

> 适用版本：rtpengine 27.0.0.0（2.0.0 tag），本机 `ens33 / 172.16.40.24/24`，容器 host 网络
> 依据：`daemon/rtpengine.8` 的 INTERFACES 章节与 `daemon/main.c` 解析逻辑

---

## 一、先搞清 `--interface` 到底决定什么

它不是"监听地址"，而是**一个逻辑接口的三合一配置**：

1. **绑定**：RTP 套接字绑在这个本地地址上
2. **通告**：写进发给对端的 SDP `c=` 行（对端据此往哪发 RTP）
3. **选路**：出包源地址（决定回程能不能通）

> 现在配置是 `--interface 127.0.0.1`，等于"只在本机回环上收发音视频"。
> 本机 sipp（127.0.1.1）测得出声，**远端 SBC 一定不通**——典型表现是能接通、无声音。

## 二、语法（man 页权威版）

```
--interface=[NAME/]IP[!ADVERTISED_IP]
```

| 元素 | 说明 |
|---|---|
| `IP` | IPv4 / IPv6 / 系统网卡名（`ens33`）/ DNS 名 / 关键字 `any` |
| `NAME/` | 逻辑接口名，可把多个地址归为一组（`pub/`、`priv/`） |
| `!ADVERTISED_IP` | **通告地址**：本地真实地址在前，对端看到的地址在后（NAT 场景关键） |
| 出现多次 | 每多一个 `--interface` 就多一个逻辑接口 |
| 配置文件中 | 单行用分号分隔：`interface = pub/10.0.0.5;priv/192.168.1.5` |
| `any` | 绑定所有非回环地址；只应出现一次 |

**选择规则（容易踩）：**
- 给了 `direction` 参数 → 按 direction 指定的逻辑接口走
- **没给 direction 且有多个逻辑接口 → 永远用命令行里第一个**
- 同一逻辑接口挂多个地址 → 第一个（按地址族）为主，其余只在 ICE 时作为候选，非 ICE 场景等于浪费
- 系统网卡名会自动展开成该网卡上的所有地址（v4+v6 各算一个）
- `BASE:SUFFIX`（如 `pub:1/…`、`pub:2/…`）可按轮询分摊端口池

> 结论：**顺序即优先级**。多网卡时第一个必须是"对端最可能走的那条"。

## 三、三种生产拓扑

### 场景 A：SBC 与录音机同网段（推荐，最简单）

```yaml
- --interface
- 172.16.40.24
```

- 优点：无 NAT、无端口映射、无 MTU 意外
- 生产建议：写网卡名 `ens33` 更抗 IP 变更（自动展开该网卡所有地址，含 IPv6）

### 场景 B：双网卡 / 公私分离

```yaml
- --interface
- pub/203.0.113.10      # 公网侧，放第一个
- --interface
- priv/172.16.40.24     # 内网侧
```

- 仅当业务侧在 offer 里带 `direction=pub|priv` 才会按端点分流
- **当前 `lib/rtpengine-call-handler.js` 没有传 direction** → 实际等于只用第一个（pub），内网 SBC 会拿到公网地址导致绕行或不通
- 要真正生效需改代码：在 offer 参数里加 `direction: <按来源网段判断>`，或在 siprec-server 里按 SBC 源 IP 决策
- 只想"多地址、不区分方向"→ 用同一逻辑名（默认 `default`），第一个为主地址

### 场景 C：云主机 / VM behind NAT（本机属于此类）

本机事实：

| 项 | 值 |
|---|---|
| 内网地址 | `172.16.40.24/24`（ens33） |
| IPv4 出口 | `117.62.246.212`（NAT 后地址） |
| IPv6 | `240e:3a2:796:5710::b0/128`（公网可路由，可作为备用媒体平面） |

配置写法：

```yaml
- --interface
- 172.16.40.24!117.62.246.212
```

- SDP 里通告公网 IP，实际仍绑内网地址
- **前置条件：上游 NAT 必须把 UDP `30000-40000` 整段 1:1（或至少端口保持）映射到 `172.16.40.24`**
  - 只做 SIP 的 5070 映射不够；媒体不通 → 接通即无声
  - PAT（源端口重写）在这类多端口场景不可靠，应要求 1:1 DNAT
- 若短期拿不到端口映射：把 SIPREC 录音机放到有公网 IP 的机器，或让 SBC 走内网直连（场景 A）

## 四、控制面安全（顺手收口）

| 参数 | 现状 | 生产建议 |
|---|---|---|
| `--listen-ng 127.0.0.1:22222` | 回环 | **保持**，控制面绝不能对公网 |
| `--listen-http 0.0.0.0:9909` | 全网卡 | 改 `127.0.0.1:9909` 或删掉（当前无人使用） |
| 30000-40000/udp | 无防火墙 | ufw 现为 disabled；启用后需 `allow from <SBC网段> to any port 30000:40000 proto udp` |

## 五、落地方式（本仓库已参数化）

`docker-compose.yml` 中：

```yaml
      - --interface
      - ${RTPENGINE_INTERFACE:-127.0.0.1}
```

`.env` 里改一行即可切换，**无需改 compose**：

```bash
# 场景 A（同网段）
RTPENGINE_INTERFACE=172.16.40.24
# 场景 C（NAT，注意 ! 在 .env 中无需转义）
# RTPENGINE_INTERFACE=172.16.40.24!117.62.246.212
```

多接口需要再加一条 `--interface`（compose 数组里直接加两行），或改用配置文件：
`--config-file /etc/rtpengine/rtpengine.conf`（新语法支持 `port-min/port-max/ttl/cos` 等每接口选项）。

生效：`docker compose up -d rtpengine`（会重建容器，建议在无通话时操作）。

## 六、验证清单（改完必做）

1. **SDP 通告地址正确**
   ```bash
   docker logs --tail 50 siprec-server | grep -iE 'c=IN IP4|c=IN IP6'
   ```
   应是新地址，不是 `127.0.0.1`
2. **套接字绑对地方**
   ```bash
   ss -lunp | grep rtpengine
   ```
3. **从远端（不是本机回环）发起一通测试呼叫**——本机 sipp 测不出这个坑
4. **双向看包**
   ```bash
   sudo tcpdump -ni ens33 -c 20 'udp portrange 30000-40000'
   ```
   入包和出包都要有；只有出没有入 = NAT/防火墙没放行
5. **容器日志**
   ```bash
   docker logs rtpengine | grep -iE 'Confirmed peer address|media timeout|no usable'
   ```
6. **落盘与入库**：pcap 生成、元数据 duration 正常（`./sipp-test.sh`）

## 七、回滚

```bash
# .env 改回
RTPENGINE_INTERFACE=127.0.0.1
docker compose up -d rtpengine
```

单容器重建，不影响 drachtio / siprec-server / 数据库。

## 八、遗留风险

- 本机是 NAT 后的 VM：**是否已有 30000-40000/udp 的入站映射未知**，需网络管理员确认（这是场景 C 的硬前提）
- 业务侧未传 `direction`：双接口配置会退化为"只用第一个"，不要误以为已分流
- IPv6 地址存在但 SDP 未启用（`--interface` 未加 v6）；若 SBC 支持 v6，可加第二地址获得多路径
