# 任务产出汇总机制 · 交付报告

> 任务：`task-x8Xt4Qi2NvNY`｜业务线：`repo-Opentodo`｜执行时间：2026-11-14 06:44–07:10
> 设计/运维手册：`/home/ubuntu/Projects/one-person-company/docs/ops/task-output-loop-2026-11-14.md`

## 结论

任务系统已经有闭环：**派活必带产出落点 → 结束自动汇总 → 按任务名/时间可查**。

- 每件任务在 `tasks.output` 里都有产出落地位置：派活时可显式指定；不指定则自动分配到
  `<项目>/reports/tasks/<日期>-<taskid>-<标题>.md`，通用任务落到
  `~/Projects/reports/tasks/work/`。
- 下发 Brief 会带上【产出落地位置】和固定三节模板（`## 结论` / `## 关键取舍` / `## 待你拍板`）。
- 任务结束（done / failed / waiting / stopped）时 worker 自动生成可读汇总，写到唯一收口处
  `/home/ubuntu/Projects/reports/tasks/summaries/`，回填 DB，并重建 `INDEX.md`（最近 200 条）。
- 查询入口：`python3 tasks.py search <任务名/关键词>`、`list --date YYYY-MM-DD`、`show <id|标题>`；
  HTTP 为 `GET /api/tasks?q=&date=&node=&status=`；驾驶舱「最近的活」上方有搜索框。
- 历史数据已回填 **294 条**终态任务汇总（只摘录当时的 `result`，标注「未见文件」），
  所以现在问「那个调研怎么样了」能直接读结论，而不是 running/done。

## 关键取舍

- **不用额外模型调用换稳定性**：汇总优先读执行 agent 按模板写的产出文件，缺失时退回
  `DONE` / 任务结果；不额外烧 token，代价是汇总质量取决于 agent 是否按模板写。
- **产出位置「自动分配」而不是硬拒绝**：`TASK:` 的 3 段老格式、语音派活、CEO 自动派活
  都可能不带位置；硬拒绝会打断现有链路。现在统一自动分配并在任务卡/API 回显，
  显式指定优先。等 CEO 习惯新 `TASK:` 4 段格式后，可以再收紧成硬校验。
- **交付物留在项目内，汇总集中在跨项目收口处**：各仓的产出仍写自己的 `reports/tasks/`，
  汇总统一进 `~/Projects/reports/tasks/`，这样既能回答跨任务问题，又不把实现细节塞进一个巨型文件。
- **历史回填只摘录旧结果**：老任务没有按模板写产出，无法无损还原取舍；回填文件明确标注，
  避免把「摘录」误当成完整结论。

## 待你拍板

1. **是否把「派活必须显式给产出位置」升级为硬校验**？现在缺省会自动分配，不阻塞语音/自动派活；
   若你要求严格，我可以在 `/api/task` 和 `TASK:` 解析处直接拒绝缺省请求（推荐先观察 1 周）。
2. **是否为没写模板的任务加一次廉价模型汇总**？会更完整，但每件任务多一次调用成本
   （推荐先不加，模板命中率足够再说）。
3. **汇总保留策略**：`INDEX.md` 只列最近 200 条，DB 和历史文件仍可全量查；
   若要长期归档，可改成按月分索引（推荐需要时再做）。

## 交付清单

新增：

- `one-person-company/task_output.py`：产出位置归一、汇总提取、固定收口写入、历史检索。
- `one-person-company/tasks.py`：历史查询入口（search / list / show / backfill / finalize / index）。
- `one-person-company/tests/test_task_output.py`：7 组用例（默认落点、模板提取、缺失回退、
  收口写入、按名/日期/状态检索、TASK 四段解析、API 落库）。
- `one-person-company/docs/ops/task-output-loop-2026-11-14.md`：设计 + 使用 + 回滚手册。

修改（均已备份 `*.bak-20261114-0649`）：

- `worker.py`：tasks 补 `output/summary/summary_path/summary_at` 列；Brief 注入产出位置；
  `TASK:` 支持 4 段；done/failed/waiting/stopped 自动写汇总；记忆行带汇总路径。
- `server.py`：`/api/task` 接收并回显 `output`；`/api/tasks` 支持 `q/date/node/status/days/limit`；
  停止任务也收口。
- `ceo.py`：自动派活（议程/邮件/规则）也写默认产出位置。
- `prototype.html`：派活抽屉新增「产出落地位置（可选）」；任务详情显示产出与汇总；
  最近任务列表支持搜索历史。

## 验证

- `python3 tests/test_task_output.py`：通过（临时 DB + 临时收口目录）。
- 回归：`test_task_dedupe`、`test_thread_reuse`、`test_ask_first`、`test_chat_dispatch`、
  `test_voice_dispatch`、`test_worker_lock`、`test_node_digest`、`test_device_token`、
  `test_overdue_polling` 全过。
- `python3 -m py_compile` 5 个 Python 文件通过；`node --check` 内联 JS 通过。
- 线上：`cockpit.service` 重启 1 次，`/healthz` 返回 ok；`/api/tasks?q=task-x8...` 正常。
- 数据：未删除任何任务；`tasks` 只增 4 列；`opc.db` 备份为
  `opc.db.bak-20261114-0649`（改前由备份脚本生成）。
- 回填：294 条汇总文件，`reports/tasks/INDEX.md` 已生成。

## 怎么用

```bash
cd ~/Projects/one-person-company
python3 tasks.py search 调研
python3 tasks.py list --date 2026-11-14
python3 tasks.py show "任务产出汇总机制"
```

派活：

```text
TASK: repo-Opentodo | 调研 XXX | reports/xxx-2026-11-14.md | 完整任务描述
```
