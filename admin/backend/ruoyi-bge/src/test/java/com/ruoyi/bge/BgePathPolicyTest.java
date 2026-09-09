package com.ruoyi.bge;

import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import com.ruoyi.bge.support.BgePathPolicy;
import com.ruoyi.bge.support.BgeProxyException;
import org.junit.jupiter.api.Test;

class BgePathPolicyTest
{
    @Test
    void acceptsExpectedChineseTaskAndImageNames()
    {
        assertEquals("task-20260901_测试商品", BgePathPolicy.identifier("task-20260901_测试商品"));
        assertEquals("01 首图.jpg", BgePathPolicy.filename("01 首图.jpg", "main"));
        assertEquals("1张主图总览.jpg", BgePathPolicy.filename("1张主图总览.jpg", "overview"));
        assertEquals("2张详情页总览.jpg", BgePathPolicy.filename("2张详情页总览.jpg", "overview"));
        assertEquals("详情页完整长图.jpg", BgePathPolicy.filename("详情页完整长图.jpg", "overview"));
    }

    @Test
    void rejectsTraversalEncodedSeparatorsControlCharactersAndOversizedSegments()
    {
        assertThrows(BgeProxyException.class, () -> BgePathPolicy.identifier(".."));
        assertThrows(BgeProxyException.class, () -> BgePathPolicy.identifier("a/b"));
        assertThrows(BgeProxyException.class, () -> BgePathPolicy.identifier("a\\b"));
        assertThrows(BgeProxyException.class, () -> BgePathPolicy.identifier("a%2fb"));
        assertThrows(BgeProxyException.class, () -> BgePathPolicy.identifier("a\u0000b"));
        assertThrows(BgeProxyException.class, () -> BgePathPolicy.identifier("a".repeat(121)));
        assertThrows(BgeProxyException.class, () -> BgePathPolicy.filename("file.zip", "main"));
        assertThrows(BgeProxyException.class, () -> BgePathPolicy.filename("other.jpg", "overview"));
        assertThrows(BgeProxyException.class, () -> BgePathPolicy.group("external"));
    }

    @Test
    void filtersNeverBecomeUpstreamQueryParameters()
    {
        assertDoesNotThrow(() -> BgePathPolicy.filter("测试商品"));
        assertThrows(BgeProxyException.class, () -> BgePathPolicy.filter("../secret"));
        assertThrows(BgeProxyException.class, () -> BgePathPolicy.filter("x".repeat(81)));
    }
}
