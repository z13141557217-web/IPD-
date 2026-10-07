import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool

from app import models  # noqa: F401
from app.db import Base, get_db
from app.llm.gateway import LLMGateway, get_gateway
from app.llm.providers import MockProvider
from app.main import create_app


@pytest.fixture
def session_factory():
    # 测试用内存 SQLite，快且不依赖外部服务；迁移脚本另外在 PostgreSQL 上验证。
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    Base.metadata.create_all(engine)
    yield sessionmaker(bind=engine, expire_on_commit=False)
    engine.dispose()


@pytest.fixture
def make_client(session_factory):
    def _make(provider=None) -> TestClient:
        app = create_app()

        def _get_db():
            with session_factory() as session:
                yield session

        app.dependency_overrides[get_db] = _get_db
        app.dependency_overrides[get_gateway] = lambda: LLMGateway(provider or MockProvider())
        return TestClient(app)

    return _make


@pytest.fixture
def client(make_client) -> TestClient:
    return make_client()
