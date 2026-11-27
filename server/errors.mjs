export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Do not return driver errors verbatim. They can include usernames, hosts, and SQL.
export function publicError(error) {
  if (error instanceof ApiError) return error;
  switch (error?.code) {
    case 'ECONNREFUSED':
    case 'ENETUNREACH':
    case 'EHOSTUNREACH':
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
    case 'ECONNRESET':
    case 'EPIPE':
    case 'PROTOCOL_CONNECTION_LOST':
    case 'ER_SERVER_SHUTDOWN':
      return new ApiError(503, '无法连接数据库，请检查地址、端口和内网连通性。');
    case 'ETIMEDOUT':
    case 'PROTOCOL_SEQUENCE_TIMEOUT':
    case 'ER_QUERY_TIMEOUT':
      return new ApiError(504, '等待数据库响应超时。');
    case 'ER_ACCESS_DENIED_ERROR':
    case 'ER_DBACCESS_DENIED_ERROR':
    case 'ER_TABLEACCESS_DENIED_ERROR':
    case 'ER_COLUMNACCESS_DENIED_ERROR':
    case 'ER_SPECIFIC_ACCESS_DENIED_ERROR':
      return new ApiError(403, '数据库拒绝访问，请检查连接凭据和账号权限。');
    case 'ER_BAD_DB_ERROR':
    case 'ER_NO_SUCH_TABLE':
      return new ApiError(404, '找不到指定的数据库或数据表。');
    case 'ER_NO_DB_ERROR':
      return new ApiError(400, '请先选择数据库，或在 SQL 中使用完整的库表名。');
    case 'ER_PARSE_ERROR':
    case 'ER_BAD_FIELD_ERROR':
    case 'ER_UNKNOWN_ERROR':
      return new ApiError(422, '数据库未能执行该语句，请检查 SQL 语法、库表和字段。');
    case 'CERT_HAS_EXPIRED':
    case 'DEPTH_ZERO_SELF_SIGNED_CERT':
    case 'ERR_TLS_CERT_ALTNAME_INVALID':
    case 'UNABLE_TO_VERIFY_LEAF_SIGNATURE':
    case 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY':
    case 'HANDSHAKE_SSL_ERROR':
    case 'HANDSHAKE_NO_SSL_SUPPORT':
      return new ApiError(503, '数据库 TLS 验证失败，请检查 TLS 配置和 CA 证书。');
    default:
      return new ApiError(503, '数据库当前无法响应，请检查服务配置或稍后重试。');
  }
}
