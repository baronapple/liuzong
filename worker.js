# 理发店实时状态网页版

跟你之前做诊所网站一样的思路：静态网页放 GitHub Pages，
唯一新增的是需要一个很小的后端来存"现在忙不忙"这个状态，
用 Cloudflare Workers（免费）来做，一次性部署，之后基本不用再碰。

## 目录结构

```
barber-status-web/
├── docs/                    # 前端，直接放 GitHub Pages
│   ├── index.html            # 顾客端（首页，顾客点群里的链接看这个）
│   └── owner.html            # 老板端（密码保护，老板收藏这个链接）
└── worker/                  # 后端，部署到 Cloudflare
    ├── worker.js
    └── wrangler.toml
```

## 部署步骤

### 第一步：部署后端（Cloudflare Worker）

1. 去 [dash.cloudflare.com](https://dash.cloudflare.com) 免费注册一个账号
2. 本地装 Cloudflare 的命令行工具（在终端跑）：
   ```
   npm install -g wrangler
   wrangler login
   ```
   会自动打开浏览器，登录你刚注册的账号授权。

3. 创建 KV 数据库（用来存店铺状态）：
   ```
   cd worker
   wrangler kv namespace create STATUS_KV
   ```
   跑完会输出一段类似这样的内容：
   ```
   [[kv_namespaces]]
   binding = "STATUS_KV"
   id = "abc123..."
   ```
   把这个 `id` 复制下来，填到 `worker/wrangler.toml` 里替换掉 `your-kv-namespace-id`。

4. 设置老板端密码：
   ```
   wrangler secret put OWNER_PIN
   ```
   会提示你输入密码，比如输入 `1234`（回车确认，自己上线前记得改成想要的密码）。

5. 部署：
   ```
   wrangler deploy
   ```
   部署成功后，终端会打印一个网址，形如：
   ```
   https://barber-status-api.你的用户名.workers.dev
   ```
   **把这个网址复制下来**，下一步要用。

### 第二步：改前端代码里的后端地址

打开 `docs/index.html` 和 `docs/owner.html`，各自找到这一行：
```js
const API_BASE = 'https://barber-status-api.YOUR-SUBDOMAIN.workers.dev';
```
换成你上一步拿到的真实网址（两个文件都要改，要保持一致）。

### 第三步：发布到 GitHub Pages

跟你之前做诊所网站一样的操作：
1. 建一个新仓库（或者用现有的），把整个 `barber-status-web` 文件夹内容 push 上去
2. 仓库 Settings → Pages → Source 选 `docs` 文件夹作为发布目录
3. 保存后，GitHub 会给你一个网址，形如：
   ```
   https://你的用户名.github.io/仓库名/
   ```

### 第四步：把链接给到店主和顾客

- **顾客端链接**：`https://你的用户名.github.io/仓库名/`（这个发到微信群置顶）
- **老板端链接**：`https://你的用户名.github.io/仓库名/owner.html`（这个只给店主，让她收藏到手机桌面）

## 老板端怎么用

第一次打开 `owner.html` 会要求输入密码（就是你在 `wrangler secret put OWNER_PIN` 时设置的那个），
输对一次后手机会记住，之后不用重复输入。点几个按钮就能更新状态，
顾客端最多 5 秒内会自动刷新看到最新状态（顾客端每 5 秒轮询一次后端）。

## 关于"实时"的说明

网页版用的是轮询（每 5 秒问一次后端"有没有更新"），不是真正的推送，
所以顾客端最多有 5 秒延迟，对这个场景完全够用，不影响体验。
如果之后想要做到毫秒级实时，需要换成 WebSocket 方案，复杂度会明显上升，目前不建议。

## 关于稳定性的诚实提醒

Cloudflare 在国内访问总体比较稳定，但海外服务始终存在网络波动的可能性，
不能保证 100% 不受影响。如果之后发现顾客反馈"打不开"的情况变多，
可以考虑换成国内可备案的云服务商（如腾讯云），但会需要走 ICP 备案流程，
个人开发者一般 1-2 周能办下来，先用免费方案测试没问题的话再考虑要不要升级。

## 后续可扩展方向

- 多店铺：现在只有一个 `status` key，以后可以按 `shopId` 区分多条记录
- 历史数据统计：老板每次更新时，Worker 里顺手记一条日志到另一个 KV key，之后可以做"今日客流"小图表
