## 功能
  带自定义底部按钮toolbar的web ttyd.
  
  <img width="672" height="430" alt="image" src="https://github.com/user-attachments/assets/65d37a27-01c3-49fa-830e-06c263f5bae9" />

## 使用说明

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

