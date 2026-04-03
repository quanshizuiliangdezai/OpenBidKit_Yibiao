"""目录相关 API 路由。"""

import json
import logging

from fastapi import APIRouter, HTTPException

from ..models.schemas import OutlineRequest, OutlineResponse
from ..services.openai_service import OpenAIService
from ..utils.errors import AppError
from ..utils.sse import sse_chunk, sse_done, sse_error, sse_response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/outline", tags=["目录管理"])


def _serialize_outline_chunks(outline: dict) -> list[str]:
    result = json.dumps(outline, ensure_ascii=False)
    chunk_size = 256
    return [
        result[index : index + chunk_size]
        for index in range(0, len(result), chunk_size)
    ]


@router.post("/generate", response_model=OutlineResponse)
async def generate_outline(request: OutlineRequest):
    """生成完整目录结构。"""
    try:
        openai_service = OpenAIService()
        return await openai_service.generate_outline(
            overview=request.overview,
            requirements=request.requirements,
            uploaded_expand=bool(request.uploaded_expand),
            old_outline=request.old_outline,
        )
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc
    except Exception as exc:
        logger.exception("目录生成失败")
        raise HTTPException(status_code=500, detail=f"目录生成失败: {exc}") from exc


@router.post("/generate-stream")
async def generate_outline_stream(request: OutlineRequest):
    """流式生成目录结构。"""
    try:
        openai_service = OpenAIService()
    except AppError as exc:
        raise HTTPException(status_code=exc.status_code, detail=exc.message) from exc

    async def generate():
        try:
            outline = await openai_service.generate_outline(
                overview=request.overview,
                requirements=request.requirements,
                uploaded_expand=bool(request.uploaded_expand),
                old_outline=request.old_outline,
            )
            for chunk in _serialize_outline_chunks(outline):
                yield sse_chunk(chunk)
        except AppError as exc:
            yield sse_error(exc.message)
        except Exception:
            logger.exception("目录流式生成失败")
            yield sse_error("目录生成失败，请稍后重试")
        finally:
            yield sse_done()

    return sse_response(generate())
