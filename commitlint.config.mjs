// commitlint.config.mjs — Conventional Commits 规范配置
// 文档: https://commitlint.js.org
export default {
  extends: ['@commitlint/config-conventional'],
  rules: {
    // 允许的提交类型
    'type-enum': [
      2,
      'always',
      [
        'feat',      // 新功能
        'fix',       // Bug 修复
        'docs',      // 文档变更
        'style',     // 格式（不影响逻辑）
        'refactor',  // 重构（既非 feat 也非 fix）
        'perf',      // 性能优化
        'test',      // 添加/修改测试
        'chore',     // 构建过程或辅助工具变动
        'ci',        // CI 配置变更
        'revert',    // 回滚
        'build',     // 影响构建系统的变更
        'security',  // 安全修复（项目自定义）
      ],
    ],
    // subject 最大长度（允许中文描述）
    'subject-max-length': [2, 'always', 100],
    // 不强制 subject 大小写，兼容中文提交信息
    'subject-case': [0],
    // body 每行最大长度宽松设置
    'body-max-line-length': [1, 'always', 200],
  },
};
