package com.ruoyi.bge.support;

import org.springframework.http.HttpStatus;

/** Safe, user-facing failures for the self-service portal. */
public class PortalException extends RuntimeException
{
    private static final long serialVersionUID = 1L;

    private final HttpStatus status;

    public PortalException(HttpStatus status, String message)
    {
        super(message, null, false, false);
        this.status = status;
    }

    public HttpStatus getStatus()
    {
        return status;
    }

    public static PortalException badRequest(String message)
    {
        return new PortalException(HttpStatus.BAD_REQUEST, message);
    }

    public static PortalException forbidden()
    {
        return new PortalException(HttpStatus.FORBIDDEN, "当前登录状态无效或账号不可用，请重新登录。 ");
    }

    public static PortalException notFound()
    {
        return new PortalException(HttpStatus.NOT_FOUND, "未找到该用户端数据。 ");
    }

    public static PortalException conflict(String message)
    {
        return new PortalException(HttpStatus.CONFLICT, message);
    }

    public static PortalException paymentRequired(String message)
    {
        return new PortalException(HttpStatus.PAYMENT_REQUIRED, message);
    }
}
