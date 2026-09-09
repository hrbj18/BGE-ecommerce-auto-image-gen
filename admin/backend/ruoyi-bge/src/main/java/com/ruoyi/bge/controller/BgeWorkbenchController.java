package com.ruoyi.bge.controller;

import java.io.IOException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import com.ruoyi.bge.client.BgeEngineClient;
import com.ruoyi.bge.client.BgeEngineClient.WorkbenchResponse;
import com.ruoyi.bge.support.BgeProxyException;
import org.springframework.http.HttpHeaders;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartHttpServletRequest;

/**
 * Authenticated bridge for the existing React image workbench. The browser is
 * authenticated by RuoYi; only this controller is allowed to use the Node
 * engine's internal credential.
 */
@RestController
@RequestMapping("/workbench-api")
public class BgeWorkbenchController
{
    private static final String WORKBENCH_PERMISSION = "@ss.hasPermi('bge:workbench:use')";

    private final BgeEngineClient client;

    public BgeWorkbenchController(BgeEngineClient client)
    {
        this.client = client;
    }

    @PreAuthorize(WORKBENCH_PERMISSION)
    @RequestMapping(value = "/**", method = { RequestMethod.GET, RequestMethod.POST, RequestMethod.DELETE })
    public void proxy(HttpServletRequest request, HttpServletResponse response)
    {
        String path = workbenchPath(request);
        String method = request.getMethod();
        if (!isAllowed(method, path))
        {
            throw BgeProxyException.invalidParameter();
        }
        String query = request.getQueryString();
        if (query != null && (query.indexOf('\r') >= 0 || query.indexOf('\n') >= 0 || query.indexOf('#') >= 0))
        {
            throw BgeProxyException.invalidParameter();
        }
        String upstreamPath = query == null || query.isEmpty() ? path : path + "?" + query;
        try
        {
            WorkbenchResponse upstream = request instanceof MultipartHttpServletRequest multipart
                    ? client.forwardWorkbenchMultipartRequest(method, upstreamPath,
                            request.getHeader("X-Idempotency-Key"), multipart)
                    : client.forwardWorkbenchRequest(method, upstreamPath,
                            request.getContentType(), request.getHeader("X-Idempotency-Key"), request.getInputStream());
            try (upstream)
            {
                response.setStatus(upstream.statusCode());
                if (!upstream.contentType().isEmpty())
                {
                    response.setContentType(upstream.contentType());
                }
                if (!upstream.contentDisposition().isEmpty())
                {
                    response.setHeader(HttpHeaders.CONTENT_DISPOSITION, upstream.contentDisposition());
                }
                response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
                response.setHeader("X-Content-Type-Options", "nosniff");
                if (upstream.contentLength() >= 0)
                {
                    response.setContentLengthLong(upstream.contentLength());
                }
                upstream.body().transferTo(response.getOutputStream());
            }
        }
        catch (BgeProxyException exception)
        {
            throw exception;
        }
        catch (IOException exception)
        {
            if (!response.isCommitted())
            {
                throw BgeProxyException.unavailable();
            }
        }
    }

    private String workbenchPath(HttpServletRequest request)
    {
        String prefix = request.getContextPath() + "/workbench-api";
        String uri = request.getRequestURI();
        if (uri == null || !uri.startsWith(prefix))
        {
            throw BgeProxyException.invalidParameter();
        }
        String path = uri.substring(prefix.length());
        return path.isEmpty() ? "/" : path;
    }

    private boolean isAllowed(String method, String path)
    {
        if (path.indexOf('\\') >= 0 || path.indexOf('\r') >= 0 || path.indexOf('\n') >= 0
                || path.contains("//") || path.contains("/../") || path.endsWith("/.."))
        {
            return false;
        }
        if ("GET".equals(method))
        {
            return "/health".equals(path)
                    || path.matches("^/api/(?:jobs/[^/]+|tasks(?:/[^/]+)?|brief-expansions/[^/]+|examples(?:/[^/]+)?|outputs(?:/[^/]+)?)$")
                    || path.matches("^/(?:outputs|example-assets)/[^/]+(?:/[^/]+)*$");
        }
        if ("POST".equals(method))
        {
            return "/api/jobs".equals(path) || "/api/brief-expansions".equals(path)
                    || path.matches("^/api/jobs/[^/]+/cancel$")
                    || path.matches("^/api/outputs/[^/]+/download$");
        }
        return "DELETE".equals(method) && path.matches("^/api/(?:tasks|outputs)/[^/]+$");
    }
}
