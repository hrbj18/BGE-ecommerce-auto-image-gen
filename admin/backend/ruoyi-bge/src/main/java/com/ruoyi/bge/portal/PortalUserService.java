package com.ruoyi.bge.portal;

import java.util.Date;
import java.util.Set;
import java.util.regex.Pattern;
import com.ruoyi.bge.support.PortalException;
import com.ruoyi.common.core.domain.entity.SysUser;
import com.ruoyi.common.core.domain.model.LoginUser;
import com.ruoyi.common.utils.DateUtils;
import com.ruoyi.common.utils.SecurityUtils;
import com.ruoyi.framework.web.service.SysLoginService;
import com.ruoyi.framework.web.service.TokenService;
import com.ruoyi.system.service.ISysRoleService;
import com.ruoyi.system.service.ISysUserService;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/** Registration and role gates for the user-facing portal. */
@Service
public class PortalUserService
{
    public static final String PORTAL_ROLE = "bge_portal_user";
    private static final Pattern USERNAME = Pattern.compile("[A-Za-z0-9_]{4,20}");
    private static final int MIN_PASSWORD_LENGTH = 6;
    private static final int MAX_PASSWORD_LENGTH = 32;

    private final ISysUserService userService;
    private final ISysRoleService roleService;
    private final SysLoginService loginService;
    private final TokenService tokenService;
    private final JdbcTemplate jdbcTemplate;

    public PortalUserService(ISysUserService userService, ISysRoleService roleService,
            SysLoginService loginService, TokenService tokenService, JdbcTemplate jdbcTemplate)
    {
        this.userService = userService;
        this.roleService = roleService;
        this.loginService = loginService;
        this.tokenService = tokenService;
        this.jdbcTemplate = jdbcTemplate;
    }

    @Transactional
    public PortalProfile register(Registration request)
    {
        String username = text(request.username());
        String nickName = text(request.nickName());
        String password = request.password() == null ? "" : request.password();
        String confirmation = request.confirmPassword() == null ? "" : request.confirmPassword();

        loginService.validateCaptcha(username, text(request.code()), text(request.uuid()));
        validateRegistration(username, nickName, password, confirmation);
        if (userService.selectUserByUserName(username) != null)
        {
            throw PortalException.conflict("这个用户名已被注册，请换一个。 ");
        }

        Long roleId = portalRoleId();
        SysUser user = new SysUser();
        user.setUserName(username);
        user.setNickName(nickName);
        user.setPassword(SecurityUtils.encryptPassword(password));
        user.setStatus("0");
        user.setPwdUpdateDate(DateUtils.getNowDate());
        user.setCreateBy("portal-register");
        user.setRemark("自助作图门户注册账号");
        user.setRoleIds(new Long[] { roleId });
        if (userService.insertUser(user) != 1 || user.getUserId() == null)
        {
            throw PortalException.conflict("账号创建未完成，请稍后重试。 ");
        }
        return new PortalProfile(user.getUserId(), user.getUserName(), user.getNickName());
    }

    public PortalLogin login(Login request)
    {
        String username = text(request.username());
        SysUser user = userService.selectUserByUserName(username);
        if (user == null || !hasPortalRole(user.getUserId()))
        {
            throw PortalException.forbidden();
        }
        String token = loginService.login(username, request.password(), text(request.code()), text(request.uuid()));
        return new PortalLogin(token, profile(user));
    }

    public PortalProfile current()
    {
        LoginUser loginUser = SecurityUtils.getLoginUser();
        Long userId = loginUser.getUserId();
        if (userId == null || !hasPortalRole(userId))
        {
            throw PortalException.forbidden();
        }
        SysUser user = userService.selectUserByUserName(loginUser.getUsername());
        if (user == null || !hasPortalRole(user.getUserId()))
        {
            throw PortalException.forbidden();
        }
        return profile(user);
    }

    public void logout()
    {
        LoginUser loginUser = SecurityUtils.getLoginUser();
        if (loginUser != null && loginUser.getToken() != null)
        {
            tokenService.delLoginUser(loginUser.getToken());
        }
    }

    private boolean hasPortalRole(Long userId)
    {
        if (userId == null)
        {
            return false;
        }
        Set<String> roles = roleService.selectRolePermissionByUserId(userId);
        return roles != null && roles.contains(PORTAL_ROLE);
    }

    private Long portalRoleId()
    {
        return jdbcTemplate.query("SELECT role_id FROM sys_role WHERE role_key = ? AND status = '0' AND del_flag = '0' LIMIT 1",
                resultSet -> resultSet.next() ? resultSet.getLong(1) : null, PORTAL_ROLE);
    }

    private void validateRegistration(String username, String nickName, String password, String confirmation)
    {
        if (!USERNAME.matcher(username).matches())
        {
            throw PortalException.badRequest("用户名需为 4 到 20 位字母、数字或下划线。 ");
        }
        if (nickName.codePointCount(0, nickName.length()) < 2 || nickName.codePointCount(0, nickName.length()) > 32
                || containsControl(nickName))
        {
            throw PortalException.badRequest("昵称需为 2 到 32 个常规字符。 ");
        }
        if (password.length() < MIN_PASSWORD_LENGTH || password.length() > MAX_PASSWORD_LENGTH)
        {
            throw PortalException.badRequest("密码需为 6 到 32 位。 ");
        }
        if (!password.equals(confirmation))
        {
            throw PortalException.badRequest("两次输入的密码不一致。 ");
        }
    }

    private boolean containsControl(String value)
    {
        return value.codePoints().anyMatch(character -> character < 0x20 || character == 0x7f);
    }

    private String text(String value)
    {
        return value == null ? "" : value.trim();
    }

    private PortalProfile profile(SysUser user)
    {
        return new PortalProfile(user.getUserId(), user.getUserName(), user.getNickName());
    }

    public record Registration(String username, String nickName, String password, String confirmPassword,
            String code, String uuid)
    {
    }

    public record Login(String username, String password, String code, String uuid)
    {
    }

    public record PortalProfile(Long userId, String username, String nickName)
    {
    }

    public record PortalLogin(String token, PortalProfile user)
    {
    }
}
