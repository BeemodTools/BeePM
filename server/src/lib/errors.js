/**
 * An error the API reports to the client as
 *   { "error": { "code": "...", "message": "..." } }
 * with the given HTTP status. Anything else becomes a 500 with a generic message.
 */
export class ApiError extends Error {
    constructor(status, code, message, details) {
        super(message)
        this.status = status
        this.code = code
        this.details = details
    }
}

export const badRequest = (message, code = "bad_request", details) =>
    new ApiError(400, code, message, details)
export const unauthorized = (message = "You need to log in first.", code = "unauthorized") =>
    new ApiError(401, code, message)
export const forbidden = (message, code = "forbidden") => new ApiError(403, code, message)
export const notFound = (message = "Not found.", code = "not_found") =>
    new ApiError(404, code, message)
export const conflict = (message, code = "conflict", details) =>
    new ApiError(409, code, message, details)
export const tooMany = (message, code = "rate_limited") => new ApiError(429, code, message)
