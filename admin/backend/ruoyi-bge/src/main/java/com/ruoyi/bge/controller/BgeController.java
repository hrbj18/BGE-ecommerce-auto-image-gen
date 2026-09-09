package com.ruoyi.bge.controller;

import java.io.IOException;
import jakarta.servlet.http.HttpServletResponse;
import com.ruoyi.bge.client.BgeEngineClient.AssetResponse;
import com.ruoyi.bge.service.BgeReadService;
import com.ruoyi.bge.support.BgeProxyException;
import com.ruoyi.common.core.domain.AjaxResult;
import org.springframework.http.HttpHeaders;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * BGE 管理台只读入口。
 */
@RestController
@RequestMapping("/bge")
public class BgeController
{
    private static final String LIST_PERMISSION = "@ss.hasPermi('bge:task:list')";
    private static final String QUERY_PERMISSION = "@ss.hasPermi('bge:task:query')";
    private static final String OUTPUT_PERMISSION = "@ss.hasPermi('bge:output:view')";

    private final BgeReadService service;

    public BgeController(BgeReadService service)
    {
        this.service = service;
    }

    @PreAuthorize(LIST_PERMISSION)
    @GetMapping("/health")
    public AjaxResult health()
    {
        return AjaxResult.success(service.health());
    }

    @PreAuthorize(LIST_PERMISSION)
    @GetMapping("/tasks")
    public AjaxResult tasks(@RequestParam(required = false, defaultValue = "") String productName,
            @RequestParam(required = false, defaultValue = "") String status)
    {
        return AjaxResult.success(service.tasks(productName, status));
    }

    @PreAuthorize(QUERY_PERMISSION)
    @GetMapping("/tasks/{taskId}")
    public AjaxResult task(@PathVariable String taskId)
    {
        return AjaxResult.success(service.task(taskId));
    }

    @PreAuthorize(OUTPUT_PERMISSION)
    @GetMapping("/outputs/{outputId}")
    public AjaxResult output(@PathVariable String outputId)
    {
        return AjaxResult.success(service.output(outputId));
    }

    @PreAuthorize(OUTPUT_PERMISSION)
    @GetMapping("/outputs/{outputId}/assets/{group}/{filename:.+}")
    public void asset(@PathVariable String outputId, @PathVariable String group,
            @PathVariable String filename, HttpServletResponse response)
    {
        try (AssetResponse asset = service.asset(outputId, group, filename))
        {
            response.setStatus(HttpServletResponse.SC_OK);
            response.setContentType(asset.contentType());
            response.setHeader(HttpHeaders.CACHE_CONTROL, "no-store");
            response.setHeader("X-Content-Type-Options", "nosniff");
            if (asset.contentLength() >= 0)
            {
                response.setContentLengthLong(asset.contentLength());
            }
            asset.body().transferTo(response.getOutputStream());
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
}
