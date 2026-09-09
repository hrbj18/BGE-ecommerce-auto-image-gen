package com.ruoyi.bge.controller;

import com.ruoyi.bge.support.BgeProxyException;
import com.ruoyi.bge.support.PortalException;
import com.ruoyi.common.core.domain.AjaxResult;
import org.springframework.core.Ordered;
import org.springframework.core.annotation.Order;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

/**
 * 将内部网络和解析故障转换为固定安全响应。
 */
@Order(Ordered.HIGHEST_PRECEDENCE)
@RestControllerAdvice(assignableTypes = { BgeController.class, BgeWorkbenchController.class,
        BgePortalController.class, PortalAuthController.class })
public class BgeExceptionHandler
{
    @ExceptionHandler(BgeProxyException.class)
    public ResponseEntity<AjaxResult> handleBgeProxyException(BgeProxyException exception)
    {
        return ResponseEntity.status(exception.getStatus())
                .body(AjaxResult.error(exception.getStatus().value(), exception.getMessage()));
    }

    @ExceptionHandler(PortalException.class)
    public ResponseEntity<AjaxResult> handlePortalException(PortalException exception)
    {
        return ResponseEntity.status(exception.getStatus())
                .body(AjaxResult.error(exception.getStatus().value(), exception.getMessage()));
    }
}
