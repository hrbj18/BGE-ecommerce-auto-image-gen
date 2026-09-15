-- Productize the RuoYi shell for the BGE operations console. Idempotent.

CREATE TABLE IF NOT EXISTS bge_point_price_history (
  history_id BIGINT NOT NULL AUTO_INCREMENT,
  request_key VARCHAR(120) NOT NULL,
  payload_fingerprint CHAR(64) NOT NULL,
  generation_profile_id VARCHAR(40) NOT NULL,
  image_resolution_id VARCHAR(12) NOT NULL,
  old_points INT NOT NULL,
  new_points INT NOT NULL,
  change_reason VARCHAR(200) NOT NULL,
  updated_by VARCHAR(64) NOT NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (history_id),
  UNIQUE KEY uk_bge_price_history_request_item
    (request_key, generation_profile_id, image_resolution_id),
  KEY idx_bge_price_history_created (created_at, history_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='Audited atomic BGE point price changes';

-- Remove the upstream external link and demonstration announcements.
DELETE rm FROM sys_role_menu rm
JOIN sys_menu m ON m.menu_id = rm.menu_id
WHERE m.parent_id = 0 AND (m.path = 'http://ruoyi.vip' OR m.menu_name = '若依官网');
DELETE FROM sys_menu
WHERE parent_id = 0 AND (path = 'http://ruoyi.vip' OR menu_name = '若依官网');
DELETE FROM sys_notice
WHERE create_by = 'admin'
  AND (notice_title LIKE '若依%' OR notice_content LIKE '%ruoyi.vip%');

-- Keep the framework capabilities installed but remove non-product surfaces
-- from the daily navigation. They can be restored by an explicit maintenance
-- migration if the operating model changes.
UPDATE sys_menu SET visible = '1', update_by = 'admin', update_time = NOW()
WHERE parent_id = 0 AND path IN ('monitor', 'tool');

SET @system_root_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = 0 AND path = 'system' AND menu_type = 'M'
  ORDER BY menu_id LIMIT 1
);
UPDATE sys_menu
SET menu_name = '账号与权限', order_num = 2, icon = 'user',
    update_by = 'admin', update_time = NOW()
WHERE menu_id = @system_root_id;
UPDATE sys_menu
SET visible = '1', update_by = 'admin', update_time = NOW()
WHERE parent_id = @system_root_id
  AND path IN ('menu', 'dept', 'post', 'dict', 'config', 'notice');
UPDATE sys_menu
SET visible = '0', update_by = 'admin', update_time = NOW()
WHERE parent_id = @system_root_id AND path IN ('user', 'role', 'log');

SET @bge_root_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = 0 AND path = 'bge' AND menu_type = 'M'
  ORDER BY menu_id LIMIT 1
);
UPDATE sys_menu
SET menu_name = '生图业务', order_num = 1, icon = 'picture', visible = '0',
    update_by = 'admin', update_time = NOW()
WHERE menu_id = @bge_root_id;
UPDATE sys_menu
SET visible = '0', status = '0', update_by = 'admin', update_time = NOW()
WHERE parent_id = @bge_root_id AND path IN ('task', 'points');
