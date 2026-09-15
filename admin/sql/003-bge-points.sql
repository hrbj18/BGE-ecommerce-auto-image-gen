-- BGE points, billing and manually reviewed recharge requests.
-- Monetary payment is intentionally out of scope until a payment provider is configured.

CREATE TABLE IF NOT EXISTS bge_point_account (
  user_id BIGINT NOT NULL,
  balance BIGINT NOT NULL DEFAULT 0,
  lifetime_credited BIGINT NOT NULL DEFAULT 0,
  lifetime_spent BIGINT NOT NULL DEFAULT 0,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT chk_bge_point_balance CHECK (balance >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='BGE user point balances';

CREATE TABLE IF NOT EXISTS bge_point_ledger (
  ledger_id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  change_amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  event_type VARCHAR(32) NOT NULL,
  reference_key VARCHAR(180) NOT NULL,
  description VARCHAR(240) NOT NULL DEFAULT '',
  operator_user_id BIGINT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (ledger_id),
  UNIQUE KEY uk_bge_point_ledger_reference (reference_key),
  KEY idx_bge_point_ledger_user (user_id, ledger_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Immutable BGE point ledger';

CREATE TABLE IF NOT EXISTS bge_point_price (
  generation_profile_id VARCHAR(40) NOT NULL,
  image_resolution_id VARCHAR(12) NOT NULL,
  points INT NOT NULL,
  updated_by VARCHAR(64) NOT NULL DEFAULT 'system',
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (generation_profile_id, image_resolution_id),
  CONSTRAINT chk_bge_point_price CHECK (points > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='BGE package prices in points';

INSERT IGNORE INTO bge_point_price (generation_profile_id, image_resolution_id, points) VALUES
  ('compact-1-2', '1k', 3), ('compact-1-2', '2k', 6), ('compact-1-2', '4k', 12),
  ('compact-2-3', '1k', 5), ('compact-2-3', '2k', 10), ('compact-2-3', '4k', 20),
  ('compact-3-4', '1k', 7), ('compact-3-4', '2k', 14), ('compact-3-4', '4k', 28),
  ('standard-5-8', '1k', 13), ('standard-5-8', '2k', 26), ('standard-5-8', '4k', 52);

CREATE TABLE IF NOT EXISTS bge_point_charge (
  charge_id BIGINT NOT NULL AUTO_INCREMENT,
  request_key VARCHAR(120) NOT NULL,
  task_id VARCHAR(120) NULL,
  user_id BIGINT NOT NULL,
  generation_profile_id VARCHAR(40) NOT NULL,
  image_resolution_id VARCHAR(12) NOT NULL,
  expected_images INT NOT NULL,
  baseline_images INT NOT NULL DEFAULT 0,
  quoted_points INT NOT NULL,
  reserved_points INT NOT NULL DEFAULT 0,
  charged_points INT NOT NULL DEFAULT 0,
  delivered_images INT NOT NULL DEFAULT 0,
  status VARCHAR(20) NOT NULL DEFAULT 'reserved',
  reservation_round INT NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  settled_at DATETIME NULL,
  PRIMARY KEY (charge_id),
  UNIQUE KEY uk_bge_point_charge_request (request_key),
  UNIQUE KEY uk_bge_point_charge_task (task_id),
  KEY idx_bge_point_charge_user (user_id, status, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Idempotent point reservations and task settlement';

CREATE TABLE IF NOT EXISTS bge_recharge_request (
  request_id BIGINT NOT NULL AUTO_INCREMENT,
  user_id BIGINT NOT NULL,
  points INT NOT NULL,
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  user_note VARCHAR(200) NOT NULL DEFAULT '',
  review_note VARCHAR(200) NOT NULL DEFAULT '',
  reviewed_by BIGINT NULL,
  requested_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  reviewed_at DATETIME NULL,
  PRIMARY KEY (request_id),
  KEY idx_bge_recharge_status (status, requested_at),
  KEY idx_bge_recharge_user (user_id, requested_at),
  CONSTRAINT chk_bge_recharge_points CHECK (points IN (50, 100, 300, 500))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='User point recharge requests requiring administrator review';

-- Existing enabled users receive the same one-time welcome balance lazily used
-- for future registrations. INSERT IGNORE makes repeated initialization safe.
INSERT IGNORE INTO bge_point_account (user_id, balance, lifetime_credited)
SELECT user_id, 30, 30 FROM sys_user WHERE status = '0' AND del_flag = '0';
INSERT IGNORE INTO bge_point_ledger
  (user_id, change_amount, balance_after, event_type, reference_key, description)
SELECT a.user_id, 30, a.balance, 'welcome', CONCAT('welcome:', a.user_id), '新用户体验积分'
FROM bge_point_account a;

SET @bge_root_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = 0 AND path = 'bge' AND menu_type = 'M'
  ORDER BY menu_id LIMIT 1
);
SET @bge_points_menu_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = @bge_root_id AND path = 'points' AND menu_type = 'C'
  ORDER BY menu_id LIMIT 1
);
SET @bge_next_menu_id := GREATEST(COALESCE((SELECT MAX(menu_id) + 1 FROM sys_menu), 2000), 2000);
INSERT INTO sys_menu (
  menu_id, menu_name, parent_id, order_num, path, component, query, route_name,
  is_frame, is_cache, menu_type, visible, status, perms, icon,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @bge_next_menu_id, '积分管理', @bge_root_id, 2, 'points', 'bge/points/index', '', 'BgePoints',
  1, 0, 'C', '0', '0', 'bge:points:list', 'money',
  'admin', NOW(), '', NULL, '管理用户积分、充值申请和套餐价格'
WHERE @bge_points_menu_id IS NULL;
SET @bge_points_menu_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = @bge_root_id AND path = 'points' AND menu_type = 'C'
  ORDER BY menu_id LIMIT 1
);
UPDATE sys_menu SET menu_name = '积分管理', order_num = 2, component = 'bge/points/index',
  perms = 'bge:points:list', icon = 'money', update_by = 'admin', update_time = NOW()
WHERE menu_id = @bge_points_menu_id;

SET @bge_next_menu_id := GREATEST(COALESCE((SELECT MAX(menu_id) + 1 FROM sys_menu), 2000), 2000);
INSERT INTO sys_menu (
  menu_id, menu_name, parent_id, order_num, path, component, query, route_name,
  is_frame, is_cache, menu_type, visible, status, perms, icon,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @bge_next_menu_id, '积分调整', @bge_points_menu_id, 1, '#', '', '', '',
  1, 0, 'F', '0', '0', 'bge:points:adjust', '#',
  'admin', NOW(), '', NULL, '调整用户积分'
WHERE NOT EXISTS (SELECT 1 FROM sys_menu WHERE perms = 'bge:points:adjust');

SET @bge_next_menu_id := GREATEST(COALESCE((SELECT MAX(menu_id) + 1 FROM sys_menu), 2000), 2000);
INSERT INTO sys_menu (
  menu_id, menu_name, parent_id, order_num, path, component, query, route_name,
  is_frame, is_cache, menu_type, visible, status, perms, icon,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @bge_next_menu_id, '充值审核', @bge_points_menu_id, 2, '#', '', '', '',
  1, 0, 'F', '0', '0', 'bge:points:recharge:review', '#',
  'admin', NOW(), '', NULL, '审核人工充值申请'
WHERE NOT EXISTS (SELECT 1 FROM sys_menu WHERE perms = 'bge:points:recharge:review');

SET @bge_next_menu_id := GREATEST(COALESCE((SELECT MAX(menu_id) + 1 FROM sys_menu), 2000), 2000);
INSERT INTO sys_menu (
  menu_id, menu_name, parent_id, order_num, path, component, query, route_name,
  is_frame, is_cache, menu_type, visible, status, perms, icon,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @bge_next_menu_id, '套餐改价', @bge_points_menu_id, 3, '#', '', '', '',
  1, 0, 'F', '0', '0', 'bge:points:price:manage', '#',
  'admin', NOW(), '', NULL, '维护套餐价格并记录改价历史'
WHERE NOT EXISTS (SELECT 1 FROM sys_menu WHERE perms = 'bge:points:price:manage');

-- Remove the superseded broad permission after replacing it with separate
-- least-privilege operations.
DELETE FROM sys_role_menu
WHERE menu_id IN (SELECT menu_id FROM sys_menu WHERE perms = 'bge:points:manage');
DELETE FROM sys_menu WHERE perms = 'bge:points:manage';

SET @bge_viewer_role_id := (
  SELECT role_id FROM sys_role WHERE role_key = 'bge_viewer' AND del_flag = '0' ORDER BY role_id LIMIT 1
);
INSERT IGNORE INTO sys_role_menu (role_id, menu_id)
SELECT @bge_viewer_role_id, menu_id FROM sys_menu
WHERE @bge_viewer_role_id IS NOT NULL
  AND (menu_id IN (@bge_root_id, @bge_points_menu_id) OR perms = 'bge:points:list');

SET @bge_operator_role_id := (
  SELECT role_id FROM sys_role WHERE role_key = 'bge_operator' AND del_flag = '0' ORDER BY role_id LIMIT 1
);
INSERT IGNORE INTO sys_role_menu (role_id, menu_id)
SELECT @bge_operator_role_id, menu_id FROM sys_menu
WHERE @bge_operator_role_id IS NOT NULL
  AND (menu_id IN (@bge_root_id, @bge_points_menu_id)
    OR perms IN ('bge:points:list', 'bge:points:adjust', 'bge:points:recharge:review'));
