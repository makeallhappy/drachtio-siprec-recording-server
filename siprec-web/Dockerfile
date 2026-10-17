# siprec-web —— 单阶段,直接用宿主机已构建的产物(避免容器内 npm install 慢)
# 前置:宿主机已 cd siprec-web && npm install && (cd ui && npm install && npm run build)
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production

# 后端源码 + 后端生产依赖 + 前端构建产物(全部来自宿主机,构建快)
COPY siprec-web/server.js ./
COPY siprec-web/node_modules ./node_modules
COPY siprec-web/ui/dist ./public

# 配置走环境变量:DB_HOST/DB_PORT/DB_USER/DB_PASSWORD/DB_NAME/WEB_PORT
EXPOSE 8082
CMD ["node", "server.js"]
