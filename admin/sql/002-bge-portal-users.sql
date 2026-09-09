-- Self-service portal users deliberately get a role without any RuoYi menu.
-- Access to the portal is checked by the dedicated Java controller, where
-- ownership is enforced for every task, output, asset and write operation.

SET @portal_role_id := (
  SELECT role_id FROM sys_role
  WHERE role_key = 'bge_portal_user' AND del_flag = '0'
  ORDER BY role_id LIMIT 1
);
UPDATE sys_role
SET role_name = '生图门户用户', role_sort = 30, data_scope = '1',
    menu_check_strictly = 1, dept_check_strictly = 1, status = '0',
    remark = '只能使用自助作图门户，不能进入若依后台', update_by = 'admin', update_time = NOW()
WHERE role_id = @portal_role_id;
SET @portal_next_role_id := GREATEST(COALESCE((SELECT MAX(role_id) + 1 FROM sys_role), 100), 100);
INSERT INTO sys_role (
  role_id, role_name, role_key, role_sort, data_scope,
  menu_check_strictly, dept_check_strictly, status, del_flag,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @portal_next_role_id, '生图门户用户', 'bge_portal_user', 30, '1',
  1, 1, '0', '0',
  'admin', NOW(), '', NULL, '只能使用自助作图门户，不能进入若依后台'
WHERE @portal_role_id IS NULL;
SET @portal_role_id := (
  SELECT role_id FROM sys_role
  WHERE role_key = 'bge_portal_user' AND del_flag = '0'
  ORDER BY role_id LIMIT 1
);

-- Re-run safety: a portal user must never inherit an accidental menu grant.
DELETE FROM sys_role_menu WHERE role_id = @portal_role_id;

CREATE TABLE IF NOT EXISTS bge_portal_job (
  job_type VARCHAR(16) NOT NULL,
  job_id VARCHAR(120) NOT NULL,
  owner_user_id BIGINT NOT NULL,
  output_id VARCHAR(120) NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (job_type, job_id),
  KEY idx_bge_portal_job_owner (owner_user_id, job_type, updated_at),
  KEY idx_bge_portal_job_output (owner_user_id, output_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_general_ci
  COMMENT='BGE self-service portal task ownership; no prompts or source files are stored here';
