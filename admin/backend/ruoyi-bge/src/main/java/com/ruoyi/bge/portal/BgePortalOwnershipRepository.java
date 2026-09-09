package com.ruoyi.bge.portal;

import java.util.List;
import com.ruoyi.bge.support.BgePathPolicy;
import com.ruoyi.bge.support.PortalException;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Repository;
import org.springframework.transaction.annotation.Transactional;

/**
 * The only persisted link between a portal identity and a Node job. Keeping
 * this separate from Node lets the generator remain the single workflow owner
 * while Java applies authorization before every read and mutation.
 */
@Repository
public class BgePortalOwnershipRepository
{
    public static final String IMAGE = "image";
    public static final String BRIEF = "brief";
    private static final int MAX_OWNED_JOBS = 100;

    private final JdbcTemplate jdbcTemplate;

    public BgePortalOwnershipRepository(JdbcTemplate jdbcTemplate)
    {
        this.jdbcTemplate = jdbcTemplate;
    }

    @Transactional
    public void claim(long ownerUserId, String jobType, String rawJobId, String rawOutputId)
    {
        String jobId = BgePathPolicy.identifier(rawJobId);
        String outputId = optionalIdentifier(rawOutputId);
        Long existingOwner = findOwner(jobType, jobId);
        if (existingOwner != null && existingOwner.longValue() != ownerUserId)
        {
            throw PortalException.conflict("该任务已由另一个账号拥有，不能在当前账号使用。 ");
        }
        if (existingOwner == null)
        {
            jdbcTemplate.update("INSERT INTO bge_portal_job (job_type, job_id, owner_user_id, output_id) VALUES (?, ?, ?, ?)",
                    jobType, jobId, ownerUserId, outputId.isEmpty() ? null : outputId);
            return;
        }
        if (!outputId.isEmpty())
        {
            jdbcTemplate.update("UPDATE bge_portal_job SET output_id = ?, updated_at = CURRENT_TIMESTAMP "
                    + "WHERE job_type = ? AND job_id = ? AND owner_user_id = ?",
                    outputId, jobType, jobId, ownerUserId);
        }
    }

    public boolean owns(long ownerUserId, String jobType, String rawJobId)
    {
        String jobId = BgePathPolicy.identifier(rawJobId);
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM bge_portal_job WHERE job_type = ? AND job_id = ? AND owner_user_id = ?",
                Integer.class, jobType, jobId, ownerUserId);
        return count != null && count.intValue() == 1;
    }

    public List<String> listOwnedJobIds(long ownerUserId, String jobType)
    {
        return jdbcTemplate.query("SELECT job_id FROM bge_portal_job WHERE owner_user_id = ? AND job_type = ? "
                        + "ORDER BY updated_at DESC, job_id DESC LIMIT ?",
                (resultSet, rowNum) -> resultSet.getString(1), ownerUserId, jobType, MAX_OWNED_JOBS);
    }

    public boolean ownsOutput(long ownerUserId, String rawOutputId)
    {
        String outputId = BgePathPolicy.identifier(rawOutputId);
        Integer count = jdbcTemplate.queryForObject(
                "SELECT COUNT(*) FROM bge_portal_job WHERE job_type = ? AND owner_user_id = ? AND output_id = ?",
                Integer.class, IMAGE, ownerUserId, outputId);
        return count != null && count.intValue() > 0;
    }

    public void rememberOutput(long ownerUserId, String rawJobId, String rawOutputId)
    {
        String outputId = optionalIdentifier(rawOutputId);
        if (outputId.isEmpty())
        {
            return;
        }
        String jobId = BgePathPolicy.identifier(rawJobId);
        jdbcTemplate.update("UPDATE bge_portal_job SET output_id = ?, updated_at = CURRENT_TIMESTAMP "
                        + "WHERE job_type = ? AND job_id = ? AND owner_user_id = ?",
                outputId, IMAGE, jobId, ownerUserId);
    }

    public void deleteOwnedImageJob(long ownerUserId, String rawJobId)
    {
        String jobId = BgePathPolicy.identifier(rawJobId);
        jdbcTemplate.update("DELETE FROM bge_portal_job WHERE job_type = ? AND job_id = ? AND owner_user_id = ?",
                IMAGE, jobId, ownerUserId);
    }

    private Long findOwner(String jobType, String jobId)
    {
        try
        {
            return jdbcTemplate.query("SELECT owner_user_id FROM bge_portal_job WHERE job_type = ? AND job_id = ?",
                    resultSet -> resultSet.next() ? resultSet.getLong(1) : null, jobType, jobId);
        }
        catch (DataAccessException exception)
        {
            throw exception;
        }
    }

    private String optionalIdentifier(String value)
    {
        if (value == null || value.isBlank())
        {
            return "";
        }
        return BgePathPolicy.identifier(value);
    }
}
