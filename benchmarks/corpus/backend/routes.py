"""HTTP handlers; application supplies FastAPI and repositories."""
from fastapi import APIRouter, HTTPException

router = APIRouter()


@router.get('/dashboard/metrics')
async def fetch_dashboard_metrics(account_id: str, repository):
    """Load aggregate chart values scoped to the authenticated account."""
    return await repository.dashboard_summary(account_id)


@router.delete('/accounts/{account_id}')
async def deactivate_account(account_id: str, repository):
    """Soft delete preserves audit records while removing login access."""
    changed = await repository.mark_inactive(account_id)
    if not changed:
        raise HTTPException(status_code=404, detail='Account not found')
    return {'deactivated': True}


@router.get('/health/ready')
async def readiness_probe(database, queue):
    """Traffic is accepted only after required backing services respond."""
    if not await database.ping() or not await queue.ping():
        raise HTTPException(status_code=503, detail='Dependencies unavailable')
    return {'ready': True}
