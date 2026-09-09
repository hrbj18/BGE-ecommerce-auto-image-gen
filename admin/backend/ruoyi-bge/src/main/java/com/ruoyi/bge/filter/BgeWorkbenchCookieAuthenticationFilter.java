package com.ruoyi.bge.filter;

import java.io.IOException;
import java.util.Collections;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletRequestWrapper;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

/**
 * Browsers do not attach an Authorization header when rendering an image. For
 * the same-origin workbench bridge only, translate RuoYi's existing
 * Admin-Token cookie into the header consumed by the normal JWT filter.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
public class BgeWorkbenchCookieAuthenticationFilter extends OncePerRequestFilter
{
    private static final java.util.List<String> PREFIXES = java.util.List.of("/workbench-api/", "/portal-api/");
    private static final String TOKEN_COOKIE = "Admin-Token";

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request)
    {
        String uri = request.getRequestURI();
        if (uri == null)
        {
            return true;
        }
        String contextPath = request.getContextPath();
        return PREFIXES.stream().noneMatch(prefix -> uri.startsWith(contextPath + prefix));
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException
    {
        if (hasAuthorization(request) || !isSafeToken(cookieToken(request)))
        {
            chain.doFilter(request, response);
            return;
        }
        String token = cookieToken(request);
        chain.doFilter(new AuthorizationHeaderRequest(request, token), response);
    }

    private boolean hasAuthorization(HttpServletRequest request)
    {
        String value = request.getHeader("Authorization");
        return value != null && !value.isBlank();
    }

    private String cookieToken(HttpServletRequest request)
    {
        Cookie[] cookies = request.getCookies();
        if (cookies == null)
        {
            return "";
        }
        for (Cookie cookie : cookies)
        {
            if (TOKEN_COOKIE.equals(cookie.getName()))
            {
                return cookie.getValue() == null ? "" : cookie.getValue().trim();
            }
        }
        return "";
    }

    private boolean isSafeToken(String token)
    {
        if (token.isEmpty() || token.length() > 256)
        {
            return false;
        }
        for (int index = 0; index < token.length(); index++)
        {
            char character = token.charAt(index);
            if (character < 0x20 || character == 0x7f)
            {
                return false;
            }
        }
        return true;
    }

    private static final class AuthorizationHeaderRequest extends HttpServletRequestWrapper
    {
        private final String authorization;

        private AuthorizationHeaderRequest(HttpServletRequest request, String token)
        {
            super(request);
            authorization = "Bearer " + token;
        }

        @Override
        public String getHeader(String name)
        {
            return "Authorization".equalsIgnoreCase(name) ? authorization : super.getHeader(name);
        }

        @Override
        public java.util.Enumeration<String> getHeaders(String name)
        {
            return "Authorization".equalsIgnoreCase(name)
                    ? Collections.enumeration(Collections.singletonList(authorization))
                    : super.getHeaders(name);
        }
    }
}
