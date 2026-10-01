# Opentodo Web —— 运行镜像。
# 构建上下文 = 仓库根(需要同时带上 web/ 与 mcp/lib/store.js)。
#
#   docker build -f web/Dockerfile -t opentodo-web .
#
# 运行时不需要任何 npm 依赖:server.js / ops.js / chat.js 只用 Node 内置模块 +
# ../mcp/lib/store.js(同一份 JSON 数据层)。前端由 vite 构建成静态 dist/,由 server.js 发。

FROM node:22-alpine AS build
WORKDIR /app/web
COPY web/package.json web/package-lock.json ./
RUN npm ci
COPY web/ ./
RUN npm run build

FROM node:22-alpine
WORKDIR /app/web
ENV NODE_ENV=production PORT=8787
# 后端(纯 Node,bundled store.js)
COPY web/server.js web/ops.js web/chat.js web/settings.js web/providers.js web/chatstore.js web/effort.js web/effort-options.json ./
COPY mcp/lib/store.js /app/mcp/lib/store.js
# 前端产物
COPY --from=build /app/web/dist ./dist
# 运行期数据(访客 / 站长 / 配置)放这里;compose 挂卷
RUN mkdir -p /app/web/data
EXPOSE 8787
CMD ["node", "server.js"]
