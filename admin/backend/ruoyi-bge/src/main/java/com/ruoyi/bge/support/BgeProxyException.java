package com.ruoyi.bge.support;

import org.springframework.http.HttpStatus;

/**
 * 只向浏览器暴露固定安全文案的代理异常。
 */
public class BgeProxyException extends RuntimeException
{
    private static final long serialVersionUID = 1L;

    private final HttpStatus status;

    public BgeProxyException(HttpStatus status, String safeMessage)
    {
        super(safeMessage, null, false, false);
        this.status = status;
    }

    public HttpStatus getStatus()
    {
        return status;
    }

    public static BgeProxyException invalidParameter()
    {
        return new BgeProxyException(HttpStatus.BAD_REQUEST, "请求参数不合法。");
    }

    public static BgeProxyException notFound()
    {
        return new BgeProxyException(HttpStatus.NOT_FOUND, "未找到请求的 BGE 数据。");
    }

    public static BgeProxyException unavailable()
    {
        return new BgeProxyException(HttpStatus.SERVICE_UNAVAILABLE, "BGE 生图服务暂时不可用。");
    }

    public static BgeProxyException invalidUpstream()
    {
        return new BgeProxyException(HttpStatus.BAD_GATEWAY, "BGE 生图服务返回了无法识别的数据。");
    }
}
