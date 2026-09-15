package com.ruoyi.bge.points;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

import com.ruoyi.bge.support.PortalException;
import java.sql.Timestamp;
import java.time.LocalDateTime;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.datasource.DriverManagerDataSource;

class BgePointAdminServiceTest
{
    private JdbcTemplate jdbc;
    private BgePointService points;
    private BgePointAdminService admin;

    @BeforeEach
    void setUp()
    {
        DriverManagerDataSource dataSource = new DriverManagerDataSource(
                "jdbc:h2:mem:point-admin-" + System.nanoTime() + ";MODE=MySQL;DB_CLOSE_DELAY=-1", "sa", "");
        jdbc = new JdbcTemplate(dataSource);
        jdbc.execute("CREATE TABLE sys_user (user_id BIGINT PRIMARY KEY, user_name VARCHAR(64), nick_name VARCHAR(64), del_flag CHAR(1) DEFAULT '0')");
        jdbc.execute("CREATE TABLE bge_point_account (user_id BIGINT PRIMARY KEY, balance BIGINT NOT NULL, lifetime_credited BIGINT NOT NULL DEFAULT 0, lifetime_spent BIGINT NOT NULL DEFAULT 0, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
        jdbc.execute("CREATE TABLE bge_point_ledger (ledger_id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, change_amount BIGINT NOT NULL, balance_after BIGINT NOT NULL, event_type VARCHAR(32) NOT NULL, reference_key VARCHAR(180) NOT NULL UNIQUE, description VARCHAR(240) NOT NULL DEFAULT '', operator_user_id BIGINT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)");
        jdbc.execute("CREATE TABLE bge_point_price (generation_profile_id VARCHAR(40) NOT NULL, image_resolution_id VARCHAR(12) NOT NULL, points INT NOT NULL, updated_by VARCHAR(64) DEFAULT 'system', updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (generation_profile_id, image_resolution_id))");
        jdbc.execute("CREATE TABLE bge_point_price_history (history_id BIGINT AUTO_INCREMENT PRIMARY KEY, request_key VARCHAR(120) NOT NULL, payload_fingerprint CHAR(64) NOT NULL, generation_profile_id VARCHAR(40) NOT NULL, image_resolution_id VARCHAR(12) NOT NULL, old_points INT NOT NULL, new_points INT NOT NULL, change_reason VARCHAR(200) NOT NULL, updated_by VARCHAR(64) NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE(request_key,generation_profile_id,image_resolution_id))");
        jdbc.execute("CREATE TABLE bge_point_charge (charge_id BIGINT AUTO_INCREMENT PRIMARY KEY, request_key VARCHAR(120) NOT NULL UNIQUE, task_id VARCHAR(120) UNIQUE, user_id BIGINT NOT NULL, generation_profile_id VARCHAR(40) NOT NULL, image_resolution_id VARCHAR(12) NOT NULL, expected_images INT NOT NULL, baseline_images INT NOT NULL DEFAULT 0, quoted_points INT NOT NULL, reserved_points INT NOT NULL DEFAULT 0, charged_points INT NOT NULL DEFAULT 0, delivered_images INT NOT NULL DEFAULT 0, status VARCHAR(20) NOT NULL DEFAULT 'reserved', reservation_round INT NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, settled_at TIMESTAMP)");
        jdbc.execute("CREATE TABLE bge_recharge_request (request_id BIGINT AUTO_INCREMENT PRIMARY KEY, user_id BIGINT NOT NULL, points INT NOT NULL, status VARCHAR(16) NOT NULL DEFAULT 'pending', user_note VARCHAR(200) NOT NULL DEFAULT '', review_note VARCHAR(200) NOT NULL DEFAULT '', reviewed_by BIGINT, requested_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, reviewed_at TIMESTAMP)");
        jdbc.update("INSERT INTO sys_user VALUES (1,'portal_user','门户用户','0'),(9,'admin_user','管理员','0')");
        for (String profile : List.of("compact-1-2", "compact-2-3", "compact-3-4", "standard-5-8"))
        {
            for (String resolution : List.of("1k", "2k", "4k"))
            {
                jdbc.update("INSERT INTO bge_point_price VALUES (?,?,10,'system',CURRENT_TIMESTAMP)", profile, resolution);
            }
        }
        points = new BgePointService(jdbc);
        admin = new BgePointAdminService(jdbc, points);
        points.account(1);
    }

    @Test
    void ledgerPaginationAcceptsEmptyDateFilters()
    {
        var page = admin.ledgers("portal", "", "", "", 1, 20);
        assertEquals(1, page.total());
        assertEquals("welcome", page.rows().get(0).eventType());
    }

    @Test
    void completePriceTableIsAtomicAuditedAndIdempotent()
    {
        List<BgePointAdminService.PriceInput> prices = priceInputs(20);
        admin.updatePrices("price-change-0001", "上线前统一调整", "admin_user", prices);
        admin.updatePrices("price-change-0001", "重复提交不重复写入", "admin_user", prices);

        assertEquals(12, scalar("SELECT COUNT(*) FROM bge_point_price_history"));
        assertEquals(20, scalar("SELECT MIN(points) FROM bge_point_price"));
        assertEquals(20, scalar("SELECT MAX(points) FROM bge_point_price"));

        List<BgePointAdminService.PriceInput> changed = priceInputs(21);
        PortalException conflict = assertThrows(PortalException.class,
                () -> admin.updatePrices("price-change-0001", "复用编号提交不同价格", "admin_user", changed));
        assertEquals(409, conflict.getStatus().value());
        assertEquals(20, scalar("SELECT MAX(points) FROM bge_point_price"));

        List<BgePointAdminService.PriceInput> incomplete = new ArrayList<>(changed);
        incomplete.remove(0);
        assertThrows(PortalException.class,
                () -> admin.updatePrices("price-change-0002", "不完整价格表", "admin_user", incomplete));
        assertEquals(12, scalar("SELECT COUNT(*) FROM bge_point_price_history"));
    }

    @Test
    void reconciliationFindsBalanceReservationAndReviewProblems()
    {
        jdbc.update("UPDATE bge_point_account SET balance=29 WHERE user_id=1");
        jdbc.update("INSERT INTO bge_point_charge (request_key,user_id,generation_profile_id,image_resolution_id,"
                + "expected_images,quoted_points,reserved_points,status,updated_at) VALUES "
                + "('stale-charge',1,'compact-1-2','1k',3,10,10,'reserved',?)",
                Timestamp.valueOf(LocalDateTime.now().minusHours(4)));
        jdbc.update("INSERT INTO bge_recharge_request (user_id,points,status,user_note,requested_at) "
                + "VALUES (1,50,'pending','等待审核',?)", Timestamp.valueOf(LocalDateTime.now().minusHours(25)));

        var anomalies = admin.reconciliation();
        assertTrue(anomalies.stream().anyMatch(item -> item.code().equals("LEDGER_BALANCE_MISMATCH")));
        assertTrue(anomalies.stream().anyMatch(item -> item.code().equals("STALE_RESERVATION")));
        assertTrue(anomalies.stream().anyMatch(item -> item.code().equals("OVERDUE_RECHARGE_REVIEW")));
        assertEquals(3, admin.summary().anomalyCount());
    }

    private List<BgePointAdminService.PriceInput> priceInputs(int value)
    {
        List<BgePointAdminService.PriceInput> inputs = new ArrayList<>();
        for (String profile : List.of("compact-1-2", "compact-2-3", "compact-3-4", "standard-5-8"))
        {
            for (String resolution : List.of("1k", "2k", "4k"))
            {
                inputs.add(new BgePointAdminService.PriceInput(profile, resolution, value));
            }
        }
        return inputs;
    }

    private int scalar(String sql)
    {
        return jdbc.queryForObject(sql, Integer.class);
    }
}
