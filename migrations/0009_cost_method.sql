-- 0009_cost_method.sql — 独立功能：多成本法（账户级口径）
--
-- 在 FIFO 基础上新增「移动加权平均 weighted」与「摊薄成本 diluted」，
-- 口径挂在账户上（accounts.cost_method），账户下所有持仓统一跟随。
--   fifo     默认：先进先出逐批核算（原有行为）
--   weighted 只按买入移动加权，卖出不改变均价，已实现盈亏独立结算
--   diluted  摊薄成本 avg_cost = (Σ买入含费 − Σ卖出净额) ÷ 当前量，已实现盈亏恒 0
-- trades 流水表仍是唯一事实来源，切换口径只改账户配置并重算，流水不丢、可随时切回。
--
-- 幂等：Wrangler 保证每个迁移文件只应用一次。

ALTER TABLE accounts ADD COLUMN cost_method TEXT NOT NULL DEFAULT 'fifo';

INSERT INTO settings (key, value) VALUES ('schema_version', '8')
  ON CONFLICT (key) DO UPDATE SET value = '8';
