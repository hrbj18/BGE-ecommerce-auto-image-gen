-- BGE menu and roles. This script is idempotent. The viewer role is strictly
-- read-only; the separate operator role is the only role allowed to open the
-- authenticated image-workbench bridge.

SET @bge_root_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = 0 AND path = 'bge' AND menu_type = 'M'
  ORDER BY menu_id LIMIT 1
);
UPDATE sys_menu
SET menu_name = '生图管理', order_num = 1, icon = 'picture', remark = 'BGE 管理目录', update_by = 'admin', update_time = NOW()
WHERE menu_id = @bge_root_id;
SET @bge_next_menu_id := GREATEST(COALESCE((SELECT MAX(menu_id) + 1 FROM sys_menu), 2000), 2000);
INSERT INTO sys_menu (
  menu_id, menu_name, parent_id, order_num, path, component, query, route_name,
  is_frame, is_cache, menu_type, visible, status, perms, icon,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @bge_next_menu_id, '生图管理', 0, 1, 'bge', NULL, '', '',
  1, 0, 'M', '0', '0', '', 'picture',
  'admin', NOW(), '', NULL, 'BGE 只读管理目录'
WHERE @bge_root_id IS NULL;
SET @bge_root_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = 0 AND path = 'bge' AND menu_type = 'M'
  ORDER BY menu_id LIMIT 1
);

SET @bge_task_menu_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = @bge_root_id AND path = 'task' AND menu_type = 'C'
  ORDER BY menu_id LIMIT 1
);

SET @bge_workbench_menu_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = @bge_root_id AND path = 'http://127.0.0.1:8001/workbench/' AND menu_type = 'C'
  ORDER BY menu_id LIMIT 1
);
UPDATE sys_menu
SET menu_name = '电商作图', order_num = 0, perms = 'bge:workbench:use', icon = 'edit', remark = '受若依用户权限保护的电商作图工作台', update_by = 'admin', update_time = NOW()
WHERE menu_id = @bge_workbench_menu_id;
SET @bge_next_menu_id := GREATEST(COALESCE((SELECT MAX(menu_id) + 1 FROM sys_menu), 2000), 2000);
INSERT INTO sys_menu (
  menu_id, menu_name, parent_id, order_num, path, component, query, route_name,
  is_frame, is_cache, menu_type, visible, status, perms, icon,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @bge_next_menu_id, '电商作图', @bge_root_id, 0, 'http://127.0.0.1:8001/workbench/', '', '', 'BgeWorkbench',
  0, 0, 'C', '0', '0', 'bge:workbench:use', 'edit',
  'admin', NOW(), '', NULL, '受若依用户权限保护的电商作图工作台'
WHERE @bge_workbench_menu_id IS NULL;
SET @bge_workbench_menu_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = @bge_root_id AND path = 'http://127.0.0.1:8001/workbench/' AND menu_type = 'C'
  ORDER BY menu_id LIMIT 1
);
SET @bge_next_menu_id := GREATEST(COALESCE((SELECT MAX(menu_id) + 1 FROM sys_menu), 2000), 2000);
INSERT INTO sys_menu (
  menu_id, menu_name, parent_id, order_num, path, component, query, route_name,
  is_frame, is_cache, menu_type, visible, status, perms, icon,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @bge_next_menu_id, '任务中心', @bge_root_id, 1, 'task', 'bge/task/index', '', 'BgeTask',
  1, 0, 'C', '0', '0', 'bge:task:list', 'list',
  'admin', NOW(), '', NULL, 'BGE 任务和成品只读页面'
WHERE @bge_task_menu_id IS NULL;
SET @bge_task_menu_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = @bge_root_id AND path = 'task' AND menu_type = 'C'
  ORDER BY menu_id LIMIT 1
);
UPDATE sys_menu
SET menu_name = '任务中心', order_num = 1, perms = 'bge:task:list', icon = 'list', remark = 'BGE 任务和成品只读页面', update_by = 'admin', update_time = NOW()
WHERE menu_id = @bge_task_menu_id;

SET @bge_next_menu_id := GREATEST(COALESCE((SELECT MAX(menu_id) + 1 FROM sys_menu), 2000), 2000);
INSERT INTO sys_menu (
  menu_id, menu_name, parent_id, order_num, path, component, query, route_name,
  is_frame, is_cache, menu_type, visible, status, perms, icon,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @bge_next_menu_id, '任务详情', @bge_task_menu_id, 1, '#', '', '', '',
  1, 0, 'F', '0', '0', 'bge:task:query', '#',
  'admin', NOW(), '', NULL, '查看 BGE 任务详情'
WHERE NOT EXISTS (SELECT 1 FROM sys_menu WHERE perms = 'bge:task:query');

SET @bge_next_menu_id := GREATEST(COALESCE((SELECT MAX(menu_id) + 1 FROM sys_menu), 2000), 2000);
INSERT INTO sys_menu (
  menu_id, menu_name, parent_id, order_num, path, component, query, route_name,
  is_frame, is_cache, menu_type, visible, status, perms, icon,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @bge_next_menu_id, '成品查看', @bge_task_menu_id, 2, '#', '', '', '',
  1, 0, 'F', '0', '0', 'bge:output:view', '#',
  'admin', NOW(), '', NULL, '查看 BGE 成品和缩略图'
WHERE NOT EXISTS (SELECT 1 FROM sys_menu WHERE perms = 'bge:output:view');

SET @bge_role_id := (
  SELECT role_id FROM sys_role
  WHERE role_key = 'bge_viewer' AND del_flag = '0'
  ORDER BY role_id LIMIT 1
);
UPDATE sys_role
SET role_name = '生图只读员', role_sort = 20, remark = '只能查看 BGE 任务和成品', update_by = 'admin', update_time = NOW()
WHERE role_id = @bge_role_id;
SET @bge_next_role_id := GREATEST(COALESCE((SELECT MAX(role_id) + 1 FROM sys_role), 100), 100);
INSERT INTO sys_role (
  role_id, role_name, role_key, role_sort, data_scope,
  menu_check_strictly, dept_check_strictly, status, del_flag,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @bge_next_role_id, '生图只读员', 'bge_viewer', 20, '1',
  1, 1, '0', '0',
  'admin', NOW(), '', NULL, '只能查看 BGE 任务和成品'
WHERE @bge_role_id IS NULL;
SET @bge_role_id := (
  SELECT role_id FROM sys_role
  WHERE role_key = 'bge_viewer' AND del_flag = '0'
  ORDER BY role_id LIMIT 1
);

-- This dedicated role is an allowlist. Re-running the script removes any
-- accidental permissions previously attached to it, then restores only the
-- BGE read-only menu and buttons.
DELETE FROM sys_role_menu WHERE role_id = @bge_role_id;
INSERT INTO sys_role_menu (role_id, menu_id)
SELECT @bge_role_id, menu_id
FROM sys_menu
WHERE menu_id IN (@bge_root_id, @bge_task_menu_id)
   OR perms IN ('bge:task:query', 'bge:output:view');

SET @bge_operator_role_id := (
  SELECT role_id FROM sys_role
  WHERE role_key = 'bge_operator' AND del_flag = '0'
  ORDER BY role_id LIMIT 1
);
UPDATE sys_role
SET role_name = '生图操作员', role_sort = 19, remark = '可使用电商作图工作台并查看本机任务和成品', update_by = 'admin', update_time = NOW()
WHERE role_id = @bge_operator_role_id;
SET @bge_next_role_id := GREATEST(COALESCE((SELECT MAX(role_id) + 1 FROM sys_role), 100), 100);
INSERT INTO sys_role (
  role_id, role_name, role_key, role_sort, data_scope,
  menu_check_strictly, dept_check_strictly, status, del_flag,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @bge_next_role_id, '生图操作员', 'bge_operator', 19, '1',
  1, 1, '0', '0',
  'admin', NOW(), '', NULL, '可使用电商作图工作台并查看本机任务和成品'
WHERE @bge_operator_role_id IS NULL;
SET @bge_operator_role_id := (
  SELECT role_id FROM sys_role
  WHERE role_key = 'bge_operator' AND del_flag = '0'
  ORDER BY role_id LIMIT 1
);

-- The operator role deliberately has a small BGE-only allowlist. System user
-- management remains an administrator responsibility.
DELETE FROM sys_role_menu WHERE role_id = @bge_operator_role_id;
INSERT INTO sys_role_menu (role_id, menu_id)
SELECT @bge_operator_role_id, menu_id
FROM sys_menu
WHERE menu_id IN (@bge_root_id, @bge_task_menu_id, @bge_workbench_menu_id)
   OR perms IN ('bge:task:query', 'bge:output:view', 'bge:workbench:use');

-- The official demonstration account must remain disabled in this local deployment.
UPDATE sys_user SET status = '1', update_by = 'admin', update_time = NOW()
WHERE user_name = 'ry';
