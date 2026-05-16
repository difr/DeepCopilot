# PR 审核机器人启用步骤

> 本目录下的 workflow 与配置文件已就绪。要让"每次 PR 必须经过审核"真正生效，
> 还需在 GitHub 仓库 UI 完成以下三步。

---

## 1. 添加 DeepSeek API Key 到仓库 Secrets

打开：
`https://github.com/ZhouChaunge/DeepCopilot/settings/secrets/actions`

点击 **New repository secret**，添加：

| Name | Value |
| ---- | ----- |
| `DEEPSEEK_API_KEY` | 你的 DeepSeek API Key（来自 https://platform.deepseek.com/api_keys） |

> 不要把 key 写进任何代码或 workflow 文件本身。

---

## 2. 开启官方 Copilot Code Review（可选但推荐）

需要账号订阅了 Copilot Pro / Business / Enterprise。

- 个人账号：`https://github.com/settings/copilot` → 找到 **Code review** 并开启
- 组织账号：`https://github.com/organizations/<ORG>/settings/copilot/policies` → 启用 **Copilot code review**

启用后 `copilot-review.yml` 会自动把 Copilot 加为 PR 审核者并留下行内评论。
如果未启用，该 workflow 不会阻塞 PR，只会跳过。

---

## 3. 配置分支保护规则（关键！强制审核就靠它）

打开：
`https://github.com/ZhouChaunge/DeepCopilot/settings/branches`

点 **Add branch protection rule**：

- **Branch name pattern**：`main`（如果默认分支不同请相应修改）
- 勾选：
  - ✅ **Require a pull request before merging**
    - ✅ Require approvals → 设为 **1**
    - ✅ Dismiss stale pull request approvals when new commits are pushed
    - ✅ Require review from Code Owners
  - ✅ **Require status checks to pass before merging**
    - ✅ Require branches to be up to date before merging
    - 在搜索框中添加这两个 check（第一次需要先让 workflow 至少跑过一次才会出现在列表里）：
      - `ai-review`
      - `ai-review-gate`
  - ✅ **Require conversation resolution before merging**
  - ✅ **Do not allow bypassing the above settings**（让管理员也必须走 PR）
  - ✅ **Restrict who can push to matching branches**（只允许指定人/团队直推，建议留空＝全员禁止直推）

保存后，**任何人都不能直接 push 到 `main`**，必须：
1. 开 PR
2. AI 审核器跑过 ✅
3. 至少 1 个 Code Owner Approve ✅
4. 所有 conversation 都 resolved ✅

才能合并。

---

## 4. 验证

1. 新开一个分支：`git checkout -b test/review-bot`
2. 随便改一行代码 push 上去
3. 在 GitHub 上发 PR 到 `main`
4. 你应该看到：
   - Actions 标签里 `AI Code Review (DeepSeek)` 与 `Request Copilot Review` 在跑
   - PR 页面 Reviewers 自动出现 Copilot（若已启用订阅）
   - DeepSeek 在 PR 留下中文行内评论
   - "Merge" 按钮变灰，直到所有 required check 通过且有人 Approve

---

## 文件清单

| 文件 | 作用 |
| ---- | ---- |
| `.github/workflows/ai-review.yml` | DeepSeek 自动审核 + 作为 required check 的 gate |
| `.github/workflows/copilot-review.yml` | 自动把官方 Copilot 加为 PR Reviewer |
| `.github/CODEOWNERS` | 关键路径需要的审核者 |
| `.github/pull_request_template.md` | 统一的 PR 描述模板 |
| `.github/copilot-instructions.md` | 给 Copilot / DeepSeek 的项目级上下文 |
| `.github/SETUP_REVIEW_BOT.md` | 本说明（启用步骤） |

> 修改完上述设置后，可以把这份 `SETUP_REVIEW_BOT.md` 删除或归档，避免在仓库根可见。
