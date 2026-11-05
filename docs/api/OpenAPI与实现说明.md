# OpenAPI与实现说明

`openapi.yaml`是JSON风格的YAML1.2/OpenAPI3.1文档，从当前编译Controller和Zod输入管道生成，包含65个路径、86个操作、30个请求体、实际成功状态、会话/CSRF/条件/幂等头及角色。`route-index.json`提供便于检索的路由清单。生成过程不启动Nest或连接数据库。

重新生成：先pnpm build，再node scripts/generate-openapi.mjs。已使用openapi-spec-validator0.7.2执行标准校验。验证工具隔离安装在.data/openapi-validation，不是应用依赖；源码附带生成器和检查证据。

响应data当前使用通用信封。业务字段由web/services类型、后端Service返回及本目录分模块接口说明共同约束，并经200单元/26真实DB套件和真实页面核对。不能据此声称自动生成完整强类型SDK；需要对外发布SDK时应补齐逐操作响应schema及破坏性差异门禁。

实际修正：知识五类型/三状态与草稿空标题；旧schema1/新schema2流式导入路径；离线白名单接口；项目和空间创建强制Idempotency-Key且响应结构不变；环境独立Cookie与当前同源CSRF；列表不返回完整正文；GET健康检查区分live与ready。

当前服务器地址为本机3000，预发布3003，开发5173同源代理；Cookie名称可由公开GET /auth/csrf-cookie-name查询。没有任意CORS，写请求必须CSRF，凭据流程仅显式豁免。非成员404、Viewer业务写403，If-Match缺失428/过期412，同键改体409。

`openapi-planned-v2.yaml`是原F03规划草案，保留作历史比较，不再作为当前API路由或SDK生成依据。新增路由/字段需更新生成器输出、配套说明和集成测试，历史迁移不改写。
