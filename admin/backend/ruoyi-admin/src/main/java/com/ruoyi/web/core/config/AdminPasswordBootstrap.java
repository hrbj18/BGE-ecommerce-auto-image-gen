package com.ruoyi.web.core.config;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.stereotype.Component;
import com.ruoyi.common.core.domain.entity.SysUser;
import com.ruoyi.common.utils.SecurityUtils;
import com.ruoyi.system.service.ISysUserService;

/**
 * Replaces the public upstream administrator password on the first local boot.
 * Existing custom passwords are never overwritten.
 */
@Component
public class AdminPasswordBootstrap implements ApplicationRunner
{
    private static final Logger log = LoggerFactory.getLogger(AdminPasswordBootstrap.class);

    private static final String ADMIN_USER_NAME = "admin";

    private static final String UPSTREAM_DEFAULT_PASSWORD = "admin123";

    private static final int MINIMUM_LOCAL_PASSWORD_LENGTH = 6;

    private final ISysUserService userService;

    @Value("${RUOYI_ADMIN_BOOTSTRAP_PASSWORD:}")
    private String bootstrapPassword;

    public AdminPasswordBootstrap(ISysUserService userService)
    {
        this.userService = userService;
    }

    @Override
    public void run(ApplicationArguments args)
    {
        if (bootstrapPassword == null || bootstrapPassword.length() < MINIMUM_LOCAL_PASSWORD_LENGTH
                || bootstrapPassword.indexOf('\r') >= 0 || bootstrapPassword.indexOf('\n') >= 0
                || UPSTREAM_DEFAULT_PASSWORD.equals(bootstrapPassword))
        {
            throw new IllegalStateException("若依管理员本机密码缺失或不符合安全要求。");
        }

        SysUser admin = userService.selectUserByUserName(ADMIN_USER_NAME);
        if (admin == null || !Long.valueOf(1L).equals(admin.getUserId()))
        {
            throw new IllegalStateException("无法确认若依内置管理员账号，已停止启动以避免不安全初始化。");
        }

        if (SecurityUtils.matchesPassword(bootstrapPassword, admin.getPassword()))
        {
            log.info("若依管理员密码已由本机随机密钥保护。");
            return;
        }

        if (!SecurityUtils.matchesPassword(UPSTREAM_DEFAULT_PASSWORD, admin.getPassword()))
        {
            log.warn("若依管理员密码已由人工修改，本次启动不会覆盖现有密码。");
            return;
        }

        int updated = userService.resetUserPwd(admin.getUserId(), SecurityUtils.encryptPassword(bootstrapPassword));
        if (updated != 1)
        {
            throw new IllegalStateException("替换若依官方默认管理员密码失败，已停止启动。");
        }
        log.info("若依官方默认管理员密码已替换为本机随机密码。");
    }
}
