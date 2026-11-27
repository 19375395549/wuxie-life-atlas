# 无邪人生目标树｜唯一正式源码 V2.0.3

**当前唯一源码基线：用户 2026-11-27 上传并确认已部署的 `wuxie-life-atlas-pages-v2.0.2.zip`。**

本仓库的 **V2.0.3** 不是旧 V2.1 的再次打包：它是直接基于原 V2.0.2 全部 8 个部署文件进行的最小增量升级。原有目标/痛点卡片的增删查改、Notion 写入、消费预算和工资推演、PWA 图标与 Android 关联文件全部保留，并补充 Notion → 网页刷新逻辑。

- `site/`：**唯一需要部署到 Cloudflare Pages 的目录**；`_worker.js` 是唯一提供 Notion API 和 Access 身份检查的服务端脚本。
- `scripts/validate.mjs`：代码与安全配置静态检查，无任何生产 API 写入。
- `.github/workflows/deploy-pages.yml`：推送到 `main` 自动检查并用 Wrangler 上传 `site/` 到**既有的** `wuxie-life-atlas` Pages 项目；Pull Request 仅检查不部署。

## 必须遵守的原则

1. Notion 是唯一业务数据库；网页不另外创建数据库、不删除历史、不迁移既有 Notion 数据源。
2. **不要将 `NOTION_TOKEN`、Cloudflare Access 配置密钥或其他私钥写入仓库。** 旧的 Cloudflare Pages 项目环境变量应继续使用原值，无须更改数据库 ID。
3. GitHub 仓库公开可读，推送权限仅授予所有者及受其授权的集成，不要上传旧版本包。
4. GitHub Actions 部署后仍需登录 Cloudflare Access，人工核对目标预算、卡片增删改和反向同步。部署不会自动在 Notion 修改任何业务数据。
5. V2.0.2 当前生产网站**在首次自动部署验收前不得删除**，以便必要时在 Cloudflare 中回滚生产部署。

## 第一步：建立 GitHub Private 仓库

新建 `wuxie-life-atlas`（Private），将本压缩包内的仓库目录**全部内容**提交到其 `main` 分支。仓库根目录应有 `.github/`、`site/`、`scripts/`、`README.md`。不要把外层文件夹本身当作仓库内容上传。

## 第二步：配置 GitHub Actions 机密

GitHub 仓库 → Settings → Secrets and variables → Actions → New repository secret：

- `CLOUDFLARE_API_TOKEN`：在 Cloudflare 创建有 **Account → Cloudflare Pages → Edit** 权限的 API Token。
- `CLOUDFLARE_ACCOUNT_ID`：你的 Cloudflare 账户 ID。

上面两个值**只能放 GitHub Secrets，不能填入 README 或 `site/`**。GitHub 自动提供 `GITHUB_TOKEN`，不需要自己生成。

## 第三步：沿用既有 Cloudflare 站点配置

保留原 Pages 项目：`wuxie-life-atlas`。它是 Direct Upload 项目，不能原地切换到 Cloudflare 面板自带的 Git 集成，但可以用 GitHub Actions + Wrangler 自动部署到原项目。

**不要改动或泄漏既有 Pages 环境变量**：
`NOTION_TOKEN`, `NOTION_GOALS_SOURCE_ID`, `NOTION_PAINS_SOURCE_ID`, `CF_ACCESS_AUD`, `CF_ACCESS_TEAM_DOMAIN`, `ALLOWED_EMAIL`。

仓库 GitHub Actions → **无邪人生目标树 - 验证与自动部署** → Run workflow → 选择 `main` 和 `preview`。预览通过后手动运行 `production`，main 推送默认自动发布。需要临时暂停推送发布时，将仓库 Actions 变量 `AUTO_DEPLOY_PRODUCTION` 设为 `false`。

## 生产发布前的三项核对

- Cloudflare Pages 的 `wuxie-life-atlas` 原生产地址仍打开、Cloudflare Access 未失效。
- 直接在 Notion 改一个测试目标的名称/预算，回网站点击 **↻ 从 Notion 刷新**，数据更新；随后在 Notion 改回原值。
- 网站卡片编辑、删除逻辑及工资推演仍存在，观察 Notion 数据完整且未意外新增/删除。

## 版本规则

从今以后只维护 `site/` 当前正式版本。每次修改先更新现有 `site/` 源码再提交到 `main`；发布版本使用 Git 标签，如 `v2.0.3`。旧的 V1.x、V2.0、旧 V2.1 分支不放进仓库，也不参与自动部署。不要在未验收时清除 Cloudflare 历史部署。

文档参考：
- https://developers.cloudflare.com/pages/how-to/use-direct-upload-with-continuous-integration/
- https://developers.cloudflare.com/pages/functions/advanced-mode/
