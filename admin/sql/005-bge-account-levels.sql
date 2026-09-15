-- Six fixed account identities for the Haike product console. Idempotent.

UPDATE sys_role
SET role_name = '超级管理员', role_sort = 1,
    remark = '管理全部业务、账号、积分价格和系统安全', update_by = 'admin', update_time = NOW()
WHERE role_key = 'admin' AND del_flag = '0';

UPDATE sys_role
SET role_name = '运营管理员', role_sort = 2,
    remark = '处理生图任务、积分调整和充值审核', update_by = 'admin', update_time = NOW()
WHERE role_key = 'bge_operator' AND del_flag = '0';

UPDATE sys_role
SET role_name = '只读管理员', role_sort = 3,
    remark = '只查看生图任务、成品和积分记录', update_by = 'admin', update_time = NOW()
WHERE role_key = 'bge_viewer' AND del_flag = '0';

UPDATE sys_role
SET role_name = '体验用户', role_sort = 10,
    remark = '新注册用户，可登录用户端并使用积分生图', update_by = 'admin', update_time = NOW()
WHERE role_key = 'bge_portal_user' AND del_flag = '0';

SET @next_role_id := GREATEST(COALESCE((SELECT MAX(role_id) + 1 FROM sys_role), 100), 100);
INSERT INTO sys_role (
  role_id, role_name, role_key, role_sort, data_scope,
  menu_check_strictly, dept_check_strictly, status, del_flag,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @next_role_id, '标准用户', 'bge_customer', 11, '1',
  1, 1, '0', '0', 'admin', NOW(), '', NULL,
  '正式使用用户，可登录用户端并使用积分生图'
WHERE NOT EXISTS (
  SELECT 1 FROM sys_role WHERE role_key = 'bge_customer' AND del_flag = '0'
);

SET @next_role_id := GREATEST(COALESCE((SELECT MAX(role_id) + 1 FROM sys_role), 100), 100);
INSERT INTO sys_role (
  role_id, role_name, role_key, role_sort, data_scope,
  menu_check_strictly, dept_check_strictly, status, del_flag,
  create_by, create_time, update_by, update_time, remark
)
SELECT
  @next_role_id, '重点用户', 'bge_priority_customer', 12, '1',
  1, 1, '0', '0', 'admin', NOW(), '', NULL,
  '重点服务用户，可登录用户端并使用积分生图'
WHERE NOT EXISTS (
  SELECT 1 FROM sys_role WHERE role_key = 'bge_priority_customer' AND del_flag = '0'
);

UPDATE sys_role
SET role_name = '标准用户', role_sort = 11, status = '0', data_scope = '1',
    remark = '正式使用用户，可登录用户端并使用积分生图', update_by = 'admin', update_time = NOW()
WHERE role_key = 'bge_customer' AND del_flag = '0';

UPDATE sys_role
SET role_name = '重点用户', role_sort = 12, status = '0', data_scope = '1',
    remark = '重点服务用户，可登录用户端并使用积分生图', update_by = 'admin', update_time = NOW()
WHERE role_key = 'bge_priority_customer' AND del_flag = '0';

-- Customer levels never grant access to the management console.
DELETE rm FROM sys_role_menu rm
JOIN sys_role r ON r.role_id = rm.role_id
WHERE r.role_key IN ('bge_portal_user', 'bge_customer', 'bge_priority_customer');

-- Replace the disabled upstream demonstration account with no visible row.
UPDATE sys_user SET del_flag = '2', update_by = 'admin', update_time = NOW()
WHERE user_id = 2 AND user_name = 'ry' AND status = '1' AND del_flag = '0';

SET @system_root_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = 0 AND path = 'system' AND menu_type = 'M'
  ORDER BY menu_id LIMIT 1
);
UPDATE sys_menu
SET menu_name = '账号管理', order_num = 2, icon = 'user',
    update_by = 'admin', update_time = NOW()
WHERE menu_id = @system_root_id;
UPDATE sys_menu
SET menu_name = '账号列表', order_num = 1, visible = '0', icon = 'user',
    update_by = 'admin', update_time = NOW()
WHERE parent_id = @system_root_id AND path = 'user';
UPDATE sys_menu
SET visible = '1', status = '1', update_by = 'admin', update_time = NOW()
WHERE parent_id = @system_root_id AND path = 'role';
SET @role_menu_id := (
  SELECT menu_id FROM sys_menu
  WHERE parent_id = @system_root_id AND path = 'role'
  ORDER BY menu_id LIMIT 1
);
UPDATE sys_menu
SET visible = '1', status = '1', update_by = 'admin', update_time = NOW()
WHERE parent_id = @role_menu_id;
UPDATE sys_menu
SET menu_name = '操作记录', order_num = 2, visible = '0',
    update_by = 'admin', update_time = NOW()
WHERE parent_id = @system_root_id AND path = 'log';
