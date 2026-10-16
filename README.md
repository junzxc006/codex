# Mihomo + MetaCubeXD 部署与源码备份

此仓库整理用户提供的 Docker Compose，并保留两个上游项目的源码快照。

## 文件

- `docker-compose.yml`：用户原文件，内容保持不变。
- `config/config.yaml.example`：最小配置示例，只执行直连，不含节点或订阅。
- `upstream/mihomo/`：MetaCubeX/mihomo 的 `Meta` 分支源码，保留 GPL-3.0 许可证。
- `upstream/metacubexd/`：MetaCubeX/metacubexd 的 `main` 分支源码，保留 MIT 许可证。
- `UPSTREAM.json`：上游地址、准确提交号和源码归档校验值。

快照不包含 Git 历史、依赖缓存、Docker 镜像或运行数据。源码未经修改。两个 `latest` 镜像标签会变化，不能保证它们与本次源码快照对应。当前 Compose 继续使用上游镜像，不会自动编译这些源码。

## 一行下载

在装有 Git 的机器上执行：

```sh
git clone --branch main https://github.com/junzxc006/123.git && cd 123
```

私有仓库需要先配置 GitHub 认证。此命令适用于 `123` 目录尚不存在的情况。

下载本次 `leo_happy` 源码备份版本：

```sh
git clone --branch leo_happy --depth 1 https://github.com/junzxc006/123.git
```

标签检出后处于 detached HEAD；如果需要继续修改并提交，进入目录后执行 `git switch -c my-changes`。

## 配置并启动

需要 Docker 和 Docker Compose 插件。在仓库根目录操作：

```sh
cp -n config/config.yaml.example config/config.yaml
```

编辑 `config/config.yaml`，将 `secret` 的占位符替换成自己的随机密码，再根据需要添加真实节点、订阅和规则。实际配置已列入根目录 `.gitignore`，不要强制上传它。

原 Compose 将 7890、9090、18090 端口绑定到宿主机所有网卡。请在自己的部署环境中用防火墙限定访问范围；管理面板连接 Mihomo 时，填写浏览器可访问的宿主机地址、9090 端口和你设置的 secret。

```sh
docker compose config --quiet
docker compose up -d
docker compose logs --tail=100
```

在同一台机器打开面板端口 `18090`，管理接口端口为 `9090`。面板中的 `mihomo` 服务名通常只能由容器内部解析，浏览器应填写宿主机地址。

以后在仓库目录中更新：

```sh
git pull --ff-only && docker compose pull && docker compose up -d
```

更新 `latest` 会获取当时的上游镜像；如需固定部署，应记录并使用镜像 digest。Git 仓库只保存配置和源码，运行数据需单独备份。

## 源码与许可证

- Mihomo：https://github.com/MetaCubeX/mihomo/tree/Meta ，许可证见 `upstream/mihomo/LICENSE`。
- MetaCubeXD：https://github.com/MetaCubeX/metacubexd ，许可证见 `upstream/metacubexd/LICENSE`。

保留上游版权和许可证；后续修改或分发须继续遵守各自许可证。源码留在 `upstream/` 下，作为本仓库的一部分上传，不是依赖上游在线状态的 Git submodule。

若要自己构建镜像，应按各上游说明准备工具链和依赖。Mihomo 的 Dockerfile 需要先生成 `bin/` 下的二进制，不能直接对源码目录执行普通 Docker build 就假定可以完成编译。

## 本次验证范围

已核对源码文件与所记录提交的 Git 归档一致，检查原 Compose 可被 Docker Compose 解析。未启动代理、验证真实订阅或编译源码。
