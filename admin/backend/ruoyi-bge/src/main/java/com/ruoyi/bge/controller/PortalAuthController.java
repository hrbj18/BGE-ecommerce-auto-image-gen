package com.ruoyi.bge.controller;

import java.time.Duration;
import jakarta.servlet.http.HttpServletResponse;
import com.ruoyi.bge.portal.PortalUserService;
import com.ruoyi.bge.portal.PortalUserService.Login;
import com.ruoyi.bge.portal.PortalUserService.PortalLogin;
import com.ruoyi.bge.portal.PortalUserService.Registration;
import com.ruoyi.common.core.domain.AjaxResult;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

/** Public registration/login endpoints for the separate user portal. */
@RestController
@RequestMapping("/portal-auth")
public class PortalAuthController
{
    private static final String TOKEN_COOKIE = "Admin-Token";
    private final PortalUserService portalUserService;

    public PortalAuthController(PortalUserService portalUserService)
    {
        this.portalUserService = portalUserService;
    }

    @PostMapping("/register")
    public AjaxResult register(@RequestBody Registration request)
    {
        return AjaxResult.success(portalUserService.register(request));
    }

    @PostMapping("/login")
    public AjaxResult login(@RequestBody Login request, HttpServletResponse response)
    {
        PortalLogin login = portalUserService.login(request);
        response.addHeader(HttpHeaders.SET_COOKIE, portalCookie(login.token(), Duration.ofMinutes(30)).toString());
        AjaxResult result = AjaxResult.success(login.user());
        result.put("token", login.token());
        result.put("user", login.user());
        return result;
    }

    @GetMapping("/me")
    public AjaxResult current()
    {
        return AjaxResult.success(portalUserService.current());
    }

    @PostMapping("/logout")
    public AjaxResult logout(HttpServletResponse response)
    {
        portalUserService.logout();
        response.addHeader(HttpHeaders.SET_COOKIE, portalCookie("", Duration.ZERO).toString());
        return AjaxResult.success();
    }

    private ResponseCookie portalCookie(String token, Duration maxAge)
    {
        return ResponseCookie.from(TOKEN_COOKIE, token)
                .httpOnly(true)
                .sameSite("Lax")
                .path("/portal-api")
                .maxAge(maxAge)
                .build();
    }
}
