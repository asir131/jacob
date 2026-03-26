# Express Auth Backend (OTP Signup + Login)

## Setup

1. Install dependencies:
```bash
npm install
```

2. Fill all values in `.env`.

3. Run in development:
```bash
npm run dev
```

4. Run in production:
```bash
npm start
```

Base URL: `http://localhost:5000`

## Environment Variables (`.env`)

```env
PORT=5000
MONGODB_URI=mongodb://127.0.0.1:27017/express-auth

JWT_SECRET=your_jwt_secret
JWT_EXPIRES_IN=15m

SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your_email@example.com
SMTP_PASS=your_app_password
SMTP_FROM="No Reply <your_email@example.com>"
```

## Roles

- `client` and `provider`: can signup with OTP verification.
- `superAdmin`: supported in the system and login flow, but no public signup API is provided.
  Create super admin directly in DB (with hashed password) or from a private internal script.

## Token Defaults

- Access token expiry comes from `JWT_EXPIRES_IN` (or default `15m` if empty).
- Refresh token secret uses `JWT_SECRET`.
- Refresh token expiry is fixed to `30d`.

## API List

### 1) Health Check

- Method: `GET`
- URL: `/api/health`
- Body: No body

Response example:
```json
{
  "success": true,
  "message": "Server is running"
}
```

### 2) Signup (Send OTP)

- Method: `POST`
- URL: `/api/auth/signup`
- Allowed roles in this API: `client`, `provider`

Request body example:
```json
{
  "firstName": "Jacob",
  "lastName": "Mia",
  "email": "jacob@example.com",
  "password": "Pass1234",
  "role": "client"
}
```

Success response example:
```json
{
  "success": true,
  "message": "OTP sent to email. Verify OTP to complete signup.",
  "data": {
    "email": "jacob@example.com",
    "otpExpiresInMinutes": 10
  }
}
```

### 3) Verify Signup OTP (Confirm Signup)

- Method: `POST`
- URL: `/api/auth/verify-signup-otp`

Request body example:
```json
{
  "email": "jacob@example.com",
  "otp": "1234"
}
```

Success response example:
```json
{
  "success": true,
  "message": "Signup confirmed successfully.",
  "data": {
    "id": "65f3e4f7686ab54f7bca0001",
    "firstName": "Jacob",
    "lastName": "Mia",
    "email": "jacob@example.com",
    "role": "client"
  }
}
```

### 4) Login

- Method: `POST`
- URL: `/api/auth/login`
- Works for all roles: `client`, `provider`, `superAdmin`

Request body example:
```json
{
  "email": "jacob@example.com",
  "password": "Pass1234"
}
```

Success response example:
```json
{
  "success": true,
  "message": "Login successful.",
  "data": {
    "accessToken": "jwt_access_token_here",
    "refreshToken": "jwt_refresh_token_here",
    "user": {
      "id": "65f3e4f7686ab54f7bca0001",
      "firstName": "Jacob",
      "lastName": "Mia",
      "email": "jacob@example.com",
      "role": "client"
    }
  }
}
```

### 5) Refresh Access Token

- Method: `POST`
- URL: `/api/auth/refresh-token`

Request body example:
```json
{
  "refreshToken": "jwt_refresh_token_here"
}
```

Success response example:
```json
{
  "success": true,
  "message": "Token refreshed successfully.",
  "data": {
    "accessToken": "new_access_token_here",
    "refreshToken": "new_refresh_token_here"
  }
}
```

### 6) Logout

- Method: `POST`
- URL: `/api/auth/logout`

Request body example:
```json
{
  "refreshToken": "jwt_refresh_token_here"
}
```

Success response example:
```json
{
  "success": true,
  "message": "Logout successful."
}
```

## Validation Rules

- `firstName`: required
- `lastName`: required
- `email`: required, valid email format
- `password`: required, minimum 8 characters
- `otp`: exactly 4 digits
- OTP expiry: 10 minutes
- `refreshToken`: required for refresh/logout

## Project Structure

```text
src/
  app.js
  server.js
  config/
    db.js
  controllers/
    authController.js
  middlewares/
    errorHandler.js
    validateRequest.js
  models/
    User.js
    OtpVerification.js
    RefreshToken.js
  routes/
    authRoutes.js
  utils/
    generateOtp.js
    sendEmail.js
```
