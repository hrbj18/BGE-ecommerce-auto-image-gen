package com.ruoyi.bge;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.when;
import java.lang.reflect.Method;
import java.util.List;
import java.util.Set;
import com.ruoyi.bge.controller.BgeController;
import com.ruoyi.bge.domain.BgeDtos.Disk;
import com.ruoyi.bge.domain.BgeDtos.Health;
import com.ruoyi.bge.service.BgeReadService;
import com.ruoyi.common.core.domain.AjaxResult;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.context.annotation.AnnotationConfigApplicationContext;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PatchMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;

class BgeControllerSecurityTest
{
    @AfterEach
    void clearSecurityContext()
    {
        SecurityContextHolder.clearContext();
    }

    @Test
    void exposesOnlyFiveGetMappingsWithTheExpectedPermissions() throws Exception
    {
        assertPermission("health", "@ss.hasPermi('bge:task:list')");
        assertPermission("tasks", "@ss.hasPermi('bge:task:list')", String.class, String.class);
        assertPermission("task", "@ss.hasPermi('bge:task:query')", String.class);
        assertPermission("output", "@ss.hasPermi('bge:output:view')", String.class);
        assertPermission("asset", "@ss.hasPermi('bge:output:view')", String.class, String.class,
                String.class, jakarta.servlet.http.HttpServletResponse.class);

        int getMappings = 0;
        for (Method method : BgeController.class.getDeclaredMethods())
        {
            assertNull(method.getAnnotation(PostMapping.class));
            assertNull(method.getAnnotation(PutMapping.class));
            assertNull(method.getAnnotation(PatchMapping.class));
            assertNull(method.getAnnotation(DeleteMapping.class));
            if (method.getAnnotation(GetMapping.class) != null)
            {
                getMappings++;
            }
        }
        assertEquals(5, getMappings);
    }

    @Test
    void methodSecurityRejectsAnonymousAndUsersWithoutTheRequiredPermission()
    {
        try (AnnotationConfigApplicationContext context = new AnnotationConfigApplicationContext(SecurityTestConfig.class))
        {
            BgeController controller = context.getBean(BgeController.class);
            PermissionGate gate = context.getBean(PermissionGate.class);
            BgeReadService service = context.getBean(BgeReadService.class);
            when(service.health()).thenReturn(new Health("ok", "ready", "local-web-api", 1, 0,
                    "", "idle", true, new Disk(true, 100.0, 10.0)));

            assertThrows(AccessDeniedException.class, controller::health);

            SecurityContextHolder.getContext().setAuthentication(new UsernamePasswordAuthenticationToken(
                    "viewer", "n/a", List.of(new SimpleGrantedAuthority("ROLE_USER"))));
            assertThrows(AccessDeniedException.class, controller::health);

            gate.allow("bge:task:list");
            AjaxResult response = controller.health();
            assertEquals(200, response.get(AjaxResult.CODE_TAG));
            assertThrows(AccessDeniedException.class, () -> controller.task("task-1"));
            assertThrows(AccessDeniedException.class, () -> controller.output("out-1"));

            gate.allow("bge:task:query", "bge:output:view");
            when(service.task(anyString())).thenReturn(null);
            when(service.output(anyString())).thenReturn(null);
            assertEquals(200, controller.task("task-1").get(AjaxResult.CODE_TAG));
            assertEquals(200, controller.output("out-1").get(AjaxResult.CODE_TAG));
        }
    }

    private static void assertPermission(String methodName, String expression, Class<?>... parameterTypes)
            throws Exception
    {
        Method method = BgeController.class.getDeclaredMethod(methodName, parameterTypes);
        assertNotNull(method.getAnnotation(GetMapping.class));
        PreAuthorize permission = method.getAnnotation(PreAuthorize.class);
        assertNotNull(permission);
        assertEquals(expression, permission.value());
    }

    @Configuration
    @EnableMethodSecurity
    static class SecurityTestConfig
    {
        @Bean
        BgeReadService bgeReadService()
        {
            return mock(BgeReadService.class);
        }

        @Bean
        BgeController bgeController(BgeReadService service)
        {
            return new BgeController(service);
        }

        @Bean("ss")
        PermissionGate permissionGate()
        {
            return new PermissionGate();
        }
    }

    public static final class PermissionGate
    {
        private Set<String> permissions = Set.of();

        public boolean hasPermi(String permission)
        {
            return permissions.contains(permission);
        }

        void allow(String... values)
        {
            permissions = Set.of(values);
        }
    }
}
