#!/usr/bin/env bash
# migrate-metadata-columns.sh —— 为所有分月元数据表补齐字段与索引(幂等)
set -uo pipefail
cd "$(dirname "$0")/.."

q() {
  docker exec -i oreka-mysql sh -c 'mysql -uroot -p"$MYSQL_ROOT_PASSWORD" siprec' <<< "$1"
}

TABLES=$(q "SHOW TABLES LIKE 'recording\\_metadata\\_______';" | tail -n +2)

for T in $TABLES; do
  echo "[migrate] 表 $T"

  add_col() {
    local name="$1" ddl="$2"
    local n
    n=$(q "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema='siprec' AND table_name='$T' AND column_name='$name';" | tail -1)
    if [ "$n" = "0" ]; then
      echo "  + column $name"
      q "ALTER TABLE \`$T\` ADD COLUMN $ddl;"
    else
      echo "  = column $name 已存在"
    fi
  }
  add_idx() {
    local name="$1" ddl="$2"
    local n
    n=$(q "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema='siprec' AND table_name='$T' AND index_name='$name';" | tail -1)
    if [ "$n" = "0" ]; then
      echo "  + index $name"
      q "ALTER TABLE \`$T\` ADD $ddl;"
    else
      echo "  = index $name 已存在"
    fi
  }

  add_col thirdpty_append   "thirdpty_append VARCHAR(255) DEFAULT NULL COMMENT '第三方应用标签'"
  add_col left_channel_txt  "left_channel_txt MEDIUMTEXT DEFAULT NULL COMMENT '左声道(主叫)转写文本'"
  add_col right_channel_txt "right_channel_txt MEDIUMTEXT DEFAULT NULL COMMENT '右声道(被叫)转写文本'"
  add_col audio_size_bytes  "audio_size_bytes BIGINT UNSIGNED DEFAULT NULL COMMENT '音频文件大小(字节)'"
  add_col archived          "archived TINYINT(1) NOT NULL DEFAULT 0 COMMENT '是否已冷归档(pcap已删)'"

  add_idx idx_end_time        "KEY idx_end_time (end_time)"
  add_idx idx_thirdpty_append "KEY idx_thirdpty_append (thirdpty_append)"
  add_idx ft_caller           "FULLTEXT KEY ft_caller (caller_number, caller_name, caller_aor) WITH PARSER ngram"
  add_idx ft_callee           "FULLTEXT KEY ft_callee (callee_number, callee_name, callee_aor) WITH PARSER ngram"
done

echo "[migrate] 完成"

