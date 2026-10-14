-- 0008_trades.sql — 独立功能：持仓交易流水 + FIFO 平均成本
--
-- 目标：针对持仓个股录入买卖交易记录，用 FIFO（先进先出）逐笔法
-- 自动计算平均成本价与已实现盈亏。坐标系与主程序隔离：
--   * 只新增一张 trades 表 + holdings 两个可选列，不动任何既有字段/行为
--   * holdings.qty / avg_cost 仍是主程序在写；本功能开启某持仓的 trade_mode 后，
--     才由交易流水回算并写回这两个字段，关闭后立即恢复手动。
--
-- 幂等：本文件可重复执行（Wrangler 也会保证只apply一次）。

-- 持仓「交易驱动」开关：0 = 手动（原行为），1 = 由交易流水推导并锁定 qty/avg_cost/realized_pnl
ALTER TABLE holdings ADD COLUMN trade_mode INTEGER NOT NULL DEFAULT 0;
-- 交易驱动持仓的累计已实现盈亏（卖出收入 − 卖出消耗的成本，含手续费）
ALTER TABLE holdings ADD COLUMN realized_pnl REAL;

-- 交易流水表（同一持仓的多笔买卖）
CREATE TABLE IF NOT EXISTS trades (
  id          TEXT PRIMARY KEY,
  holding_id  TEXT NOT NULL REFERENCES holdings (id) ON DELETE CASCADE,
  side        TEXT NOT NULL CHECK (side IN ('buy', 'sell')),
  qty         REAL NOT NULL,
  price       REAL NOT NULL,             -- 成交单价（交易币种）
  fee         REAL NOT NULL DEFAULT 0,   -- 手续费：买加进成本、卖从收入扣除
  seed        INTEGER NOT NULL DEFAULT 0,-- 1 = 打开 trade_mode 时由既有持仓自动生成的「开仓基准」买入
  traded_at   TEXT NOT NULL,             -- 交易日 YYYY-MM-DD
  note        TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_holding ON trades (holding_id, traded_at, id);

INSERT INTO settings (key, value) VALUES ('schema_version', '7')
  ON CONFLICT (key) DO UPDATE SET value = '7';