"""Stable errors shared by the control channel and MCP tools."""


class CodeConvergeError(Exception):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(message)

    def as_dict(self) -> dict:
        return {"code": self.code, "message": str(self)}
