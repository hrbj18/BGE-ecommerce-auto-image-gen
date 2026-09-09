# 若依上游来源记录

## 后端

- 官方仓库  https://github.com/yangzongzhuan/RuoYi-Vue
- 官方分支  `springboot3`
- 固定提交  `a51a838b71b446ea27256900efe7ed2faa2a02fd`
- 导入日期  2026-09-01
- 版本信息  RuoYi 3.9.2，Java 17，Spring Boot 3.5.16
- 本地目录  `admin/backend`
- 许可证  `admin/backend/LICENSE`

后端按完整提交导入，排除了上游 `.git` 元数据。项目本地增加 `ruoyi-bge` 模块，并对数据库、Redis、令牌、监听地址和监控页面配置做安全外部化。

## 前端

- 官方仓库  https://github.com/yangzongzhuan/RuoYi-Vue3
- 官方分支  `typescript`
- 固定提交  `d50306c98e1ca7cb4a49e35514662bf1b24689eb`
- 导入日期  2026-09-01
- 版本信息  RuoYi 3.9.2，Vue 3.5.26，TypeScript 5.6.3，Vite 6.4.1
- 本地目录  `admin/frontend`
- 许可证  `admin/frontend/LICENSE`

前端按完整提交导入，排除了上游 `.git` 元数据。项目本地增加 BGE 任务中心与受保护的电商作图入口，用户入口端口调整到 8001。

## 更新规则

以后升级时先核对官方完整提交和许可证，再对比本地修改。不要直接用浮动分支覆盖 `admin/`。升级后必须重新执行 Maven 测试、前端类型检查、生产构建和本项目全量免费验证。
