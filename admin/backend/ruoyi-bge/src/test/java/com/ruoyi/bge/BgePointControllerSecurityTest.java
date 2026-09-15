package com.ruoyi.bge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;

import com.ruoyi.bge.controller.BgePointController;
import java.lang.reflect.Method;
import org.junit.jupiter.api.Test;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;

class BgePointControllerSecurityTest
{
    @Test
    void protectsPointOperationsWithSeparateLeastPrivilegePermissions() throws Exception
    {
        assertPermission("summary", "@ss.hasPermi('bge:points:list')", GetMapping.class);
        assertPermission("users", "@ss.hasPermi('bge:points:list')", GetMapping.class,
                String.class, int.class, int.class);
        assertPermission("ledger", "@ss.hasPermi('bge:points:list')", GetMapping.class,
                String.class, String.class, String.class, String.class, int.class, int.class);
        assertPermission("charges", "@ss.hasPermi('bge:points:list')", GetMapping.class,
                String.class, String.class, String.class, int.class, int.class);
        assertPermission("prices", "@ss.hasPermi('bge:points:list')", GetMapping.class);
        assertPermission("priceHistory", "@ss.hasPermi('bge:points:list')", GetMapping.class);
        assertPermission("recharges", "@ss.hasPermi('bge:points:list')", GetMapping.class,
                String.class, int.class, int.class);
        assertPermission("reconciliation", "@ss.hasPermi('bge:points:list')", GetMapping.class);
        assertPermission("adjust", "@ss.hasPermi('bge:points:adjust')", PostMapping.class,
                long.class, BgePointController.Adjustment.class);
        assertPermission("review", "@ss.hasPermi('bge:points:recharge:review')", PostMapping.class,
                long.class, BgePointController.Review.class);
        assertPermission("updatePrices", "@ss.hasPermi('bge:points:price:manage')", PutMapping.class,
                BgePointController.PriceTableUpdate.class);
    }

    private void assertPermission(String name, String expression,
            Class<? extends java.lang.annotation.Annotation> mapping, Class<?>... parameters) throws Exception
    {
        Method method = BgePointController.class.getDeclaredMethod(name, parameters);
        assertNotNull(method.getAnnotation(mapping));
        PreAuthorize permission = method.getAnnotation(PreAuthorize.class);
        assertNotNull(permission);
        assertEquals(expression, permission.value());
    }
}
