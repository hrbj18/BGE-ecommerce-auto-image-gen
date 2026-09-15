package com.ruoyi.bge.points;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;

import com.ruoyi.bge.support.PortalException;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class BgePointServiceTest
{
    private JdbcTemplate jdbc;
    private BgePointService service;

    @BeforeEach
    void setUp()
    {
        DriverManagerDataSource dataSource = new DriverManagerDataSource(
                "jdbc:h2:mem:points-" + System.nanoTime() + ";MODE=MySQL;DB_CLOSE_DELAY=-1",
                "sa", "");
        jdbc = new JdbcTemplate(dataSource);
        jdbc.execute("CREATE TABLE sys_user (user_id BIGINT PRIMARY KEY, user_name VARCHAR(64), nick_name VARCHAR(64), del_flag CHAR(1) DEFAULT '0')");
        jdbc.execute("CREATE TABLE bge_point_account (user_id BIGINT PRIMARY KEY, balance BIGINT NOT NULL, lifetime_credited BIGINT NOT NULL DEFAULT 0, lifetime_spent BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
        jdbc.execute("CREATE TABLE bge_point_ledger (ledger_id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, change_amount BIGINT NOT NULL, balance_after BIGINT NOT NULL, event_type VARCHAR(32) NOT NULL, reference_key VARCHAR(180) NOT NULL UNIQUE, description VARCHAR(240) NOT NULL DEFAULT '', operator_user_id BIGINT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
        jdbc.execute("CREATE TABLE bge_point_price (generation_profile_id VARCHAR(40) NOT NULL, image_resolution_id VARCHAR(12) NOT NULL, points INT NOT NULL, updated_by VARCHAR(64) DEFAULT 'system', updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (generation_profile_id, image_resolution_id))");
        jdbc.execute("CREATE TABLE bge_point_charge (charge_id BIGINT AUTO_INCREMENT PRIMARY KEY, request_key VARCHAR(120) NOT NULL UNIQUE, task_id VARCHAR(120) UNIQUE, user_id BIGINT NOT NULL, generation_profile_id VARCHAR(40) NOT NULL, image_resolution_id VARCHAR(12) NOT NULL, expected_images INT NOT NULL, baseline_images INT NOT NULL DEFAULT 0, quoted_points INT NOT NULL, reserved_points INT NOT NULL DEFAULT 0, charged_points INT NOT NULL DEFAULT 0, delivered_images INT NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'reserved', reservation_round INT NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, settled_at TIMESTAMP)");
        jdbc.execute("CREATE TABLE bge_recharge_request (request_id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, points INT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending', user_note VARCHAR(200) NOT NULL DEFAULT '', review_note VARCHAR(200) NOT NULL DEFAULT '', reviewed_by BIGINT, requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, reviewed_at TIMESTAMP)");
        jdbc.update("INSERT INTO sys_user (user_id, user_name, nick_name) VALUES (1, 'portal_user', '门户用户')");
        jdbc.update("INSERT INTO sys_user (user_id, user_name, nick_name) VALUES (9, 'admin_user', '管理员')");
        jdbc.update("INSERT INTO bge_point_price VALUES ('compact-1-2', '1k', 3, 'system', CURRENT_TIMESTAMP)");
        jdbc.update("INSERT INTO bge_point_price VALUES ('compact-1-2', '2k', 6, 'system', CURRENT_TIMESTAMP)");
        jdbc.update("INSERT INTO bge_point_price VALUES ('compact-1-2', '4k', 12, 'system', CURRENT_TIMESTAMP)");
        service = new BgePointService(jdbc);
    }

    @Test
    void welcomePointsAreGrantedExactlyOnce()
    {
        assertEquals(30, service.account(1).balance());
        assertEquals(30, service.account(1).balance());
        assertEquals(1, count("SELECT COUNT(*) FROM bge_point_ledger WHERE reference_key = 'welcome:1'"));
    }

    @Test
    void generationReservationIsIdempotentAndInsufficientBalanceReturns402()
    {
        var first = service.reserveGeneration(1, "request-key-0001", "compact-1-2", "4k");
        var repeated = service.reserveGeneration(1, "request-key-0001", "compact-1-2", "4k");

        assertEquals(first.chargeId(), repeated.chargeId());
        assertEquals(18, service.account(1).balance());
        assertEquals(1, count("SELECT COUNT(*) FROM bge_point_ledger WHERE event_type = 'generation_reserve'"));

        service.adjust(1, -7, "测试余额边界", "adjust-balance-boundary", 9);
        PortalException error = assertThrows(PortalException.class,
                () -> service.reserveGeneration(1, "request-key-0002", "compact-1-2", "4k"));
        assertEquals(402, error.getStatus().value());
        assertEquals(11, service.account(1).balance());
    }

    @Test
    void failedAndPartialJobsRefundOnlyUndeliveredImages()
    {
        var failed = service.reserveGeneration(1, "request-key-failed", "compact-1-2", "4k");
        service.bindTask(1, failed.chargeId(), "task-failed");
        service.settleTask(1, "task-failed", 0);
        assertEquals(30, service.account(1).balance());

        var partial = service.reserveGeneration(1, "request-key-partial", "compact-1-2", "4k");
        service.bindTask(1, partial.chargeId(), "task-partial");
        service.settleTask(1, "task-partial", 1);

        assertEquals(26, service.account(1).balance());
        assertEquals(4, scalar("SELECT charged_points FROM bge_point_charge WHERE task_id = 'task-partial'"));
        assertEquals(8, scalar("SELECT change_amount FROM bge_point_ledger WHERE reference_key = 'generation-refund:"
                + partial.chargeId() + ":1'"));
    }

    @Test
    void retryChargesOnlyTheRemainingShareAndRefundsItAgainWhenNoMoreImagesArrive()
    {
        var initial = service.reserveGeneration(1, "request-key-retry", "compact-1-2", "4k");
        service.bindTask(1, initial.chargeId(), "task-retry");
        service.settleTask(1, "task-retry", 1);
        assertEquals(26, service.account(1).balance());

        var retry = service.reserveRetry(1, "task-retry", "compact-1-2", "4k", 3, 1);
        assertEquals(8, retry.points());
        assertEquals(18, service.account(1).balance());
        service.settleTask(1, "task-retry", 1);
        assertEquals(26, service.account(1).balance());

        service.reserveRetry(1, "task-retry", "compact-1-2", "4k", 3, 1);
        service.settleTask(1, "task-retry", 3);
        assertEquals(18, service.account(1).balance());
        assertEquals(12, service.account(1).lifetimeSpent());
    }

    @Test
    void rechargeCanOnlyBeReviewedOnce()
    {
        var request = service.requestRecharge(1, 50, "上线充值");
        service.reviewRecharge(request.id(), true, "已确认", 9);

        assertEquals(80, service.account(1).balance());
        PortalException repeated = assertThrows(PortalException.class,
                () -> service.reviewRecharge(request.id(), true, "再次处理", 9));
        assertEquals(409, repeated.getStatus().value());
        assertEquals(80, service.account(1).balance());
        assertEquals(1, count("SELECT COUNT(*) FROM bge_point_ledger WHERE reference_key = 'recharge:" + request.id() + "'"));
    }

    @Test
    void administratorCannotAdjustAnAccountBelowZero()
    {
        service.account(1);
        PortalException error = assertThrows(PortalException.class,
                () -> service.adjust(1, -31, "错误扣减", "adjust-negative-balance", 9));

        assertEquals(402, error.getStatus().value());
        assertEquals(30, service.account(1).balance());
        assertEquals(0, count("SELECT COUNT(*) FROM bge_point_ledger WHERE event_type = 'admin_adjustment'"));
    }

    @Test
    void administratorAdjustmentRequiresReasonAndIsIdempotent()
    {
        service.account(1);
        assertThrows(PortalException.class,
                () -> service.adjust(1, 10, "短", "adjust-short-reason", 9));

        service.adjust(1, 10, "活动补偿积分", "adjust-campaign-0001", 9);
        service.adjust(1, 10, "活动补偿积分", "adjust-campaign-0001", 9);

        assertEquals(40, service.account(1).balance());
        assertEquals(1, count("SELECT COUNT(*) FROM bge_point_ledger WHERE reference_key = 'admin-adjust:adjust-campaign-0001'"));
        PortalException conflict = assertThrows(PortalException.class,
                () -> service.adjust(1, 20, "另一笔活动补偿", "adjust-campaign-0001", 9));
        assertEquals(409, conflict.getStatus().value());
    }

    @Test
    void rejectedRechargeRequiresReason()
    {
        var request = service.requestRecharge(1, 50, "测试申请");
        PortalException error = assertThrows(PortalException.class,
                () -> service.reviewRecharge(request.id(), false, "无", 9));
        assertEquals(400, error.getStatus().value());
        assertEquals("pending", service.adminRecharges("").get(0).status());
    }

    private int count(String sql)
    {
        return jdbc.queryForObject(sql, Integer.class);
    }

    private int scalar(String sql)
    {
        return jdbc.queryForObject(sql, Integer.class);
    }
}
