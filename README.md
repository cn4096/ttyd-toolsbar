## 功能
 + 带自定义底部按钮网页版 `ssh ttyd`
  
  <img width="672" height="430" alt="image" src="https://github.com/user-attachments/assets/65d37a27-01c3-49fa-830e-06c263f5bae9" />
  
 + 带文件管理，支持 新建/删除/重命名/编辑
   
  <img width="1152" height="572" alt="image" src="https://github.com/user-attachments/assets/66dba695-f46c-4ae5-95f4-90d7f7a4f7a7" />
<img width="1032" height="564" alt="image" src="https://github.com/user-attachments/assets/ba0c7482-7c9f-447f-b20a-1dc531626abe" />

## 使用说明

这是**完全静态链接**的二进制，不依赖任何系统库。

release 的 `ttyd.aarch64`（1.3MB）是静态版，用的是 **musl libc**，但 musl 是**编译进去的** 。

所以你的设备上：

- ✅ 不需要安装任何依赖库
- ✅ 不需要 musl、glibc、openssl、libwebsockets
- ✅ 复制到任何 aarch64 Linux 设备直接运行
- ✅ Alpine、Ubuntu、Debian、OpenWrt 都能跑
- ✅ 内核版本 ≥ 3.7 即可（几乎所有现代设备都满足）

```bash
# 下载后直接用，就这么简单
chmod +x ttyd.aarch64
./ttyd.aarch64 -W -p 7681 bash
```

直接看 ttyd 的参数：常用例子：

---

**最基本——只读模式查看终端**
```bash
ttyd -p 7681 bash
```
默认只读，浏览器打开 `http://ip:7681` 可以看但不能输入。

---

**可写模式（允许用户输入操作）**
```bash
ttyd -W -p 7681 bash
```
加 `-W` 才能在浏览器里实际输入命令。

---
**启用文件管理器**
```
# 启用文件管理器（必须指定 --file-root）
ttyd -W -p 7681 --file-root /opt/app bash

# 加密码保护
ttyd -W -p 7681 -c admin:123456 --file-root /opt/app bash

```
**指定端口 + 用户名密码**
```bash
ttyd -W -p 8080 -c admin:123456 bash
```
浏览器访问时会弹出登录框，输入 `admin` / `123456`。

---

**指定工作目录**
```bash
ttyd -W -p 7681 -w /opt/app bash
```
终端打开后直接在 `/opt/app` 目录。

---

**限制只能一个人连接（用完自动退出）**
```bash
ttyd -W -p 7681 -o bash
```
第一个人断开后 ttyd 自动退出。

---

**只绑定内网网卡（不对外暴露）**
```bash
ttyd -W -p 7681 -i eth0 bash
```

---

**SSL 加密（https）**
```bash
ttyd -W -p 7681 -S -C /etc/ssl/cert.pem -K /etc/ssl/key.pem bash
```

---

**后台运行（配合 nohup）**
```bash
nohup ttyd -W -p 7681 -c admin:123456 bash > /var/log/ttyd.log 2>&1 &
```

---

**Docker 里用（常见场景）**
```bash
docker run -d \
  --name ttyd \
  -p 7681:7681 \
  tsl0922/ttyd \
  ttyd -W -c admin:123456 bash
```

---

**你的场景（battery 项目那个路径）**
```bash
# 只读监控
ttyd -p 7681 bash

# 可写 + 密码保护 + 指定工作目录
ttyd -W -p 7681 -c admin:123456 -w /opt/app/battery bash

# 后台运行
nohup ttyd -W -p 7681 -c admin:123456 -w /opt/app/battery bash &
```


## action 流程

<img width="661" height="665" alt="image" src="https://github.com/user-attachments/assets/fca5e33f-1144-40b2-a161-184b7ddd63c3" />

改文件后  html/ 文件，它就会自动生成并保存 html.h，你只需要最后打个 tag 就能发布完整的编译版本。

`Releases → Draft a new release → Choose a tag → 输入版本号 → Publish`

