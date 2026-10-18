# siprec-web —— 单阶段,直接用宿主机已构建的产物(避免容器内 npm install 慢)
# 前置:宿主机已 cd siprec-web && npm install && (cd ui && npm install && npm run build)
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# 后端源码 + 后端生产依赖 + 前端构建产物(全部来自宿主机,构建快)
COPY siprec-web/server.js ./
COPY siprec-web/auth.js ./
COPY siprec-web/users.js ./
COPY siprec-web/node_modules ./node_modules
COPY siprec-web/ui/dist ./public

# 服务器证书(HTTPS,AVAYA CA 签发)打进镜像
COPY siprec-web/certs/ork.p12 /certs/ork.p12

# 配置走环境变量:DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME/USER_DB_NAME/
#   JWT_SECRET/SSL_ENABLED/SSL_P12_PATH/SSL_P12_PASSWORD/WEB_HTTPS_PORT/WEB_PORT
EXPOSE 8444 8082
CMD ["node", "server.js"]
