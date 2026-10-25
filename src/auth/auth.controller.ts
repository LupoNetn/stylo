import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import type { AuthenticatedRequest } from './guards/jwt-cookie.guard.js';
import { CreateUserDto } from './dto/create-user.dto.js';
import { AuthService } from './auth.service.js';
import { LoginDto } from './dto/login.dto.js';
import { JwtCookieGuard } from './guards/jwt-cookie.guard.js';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Post('register')
  @HttpCode(201)
  async createUser(@Body() req: CreateUserDto) {
    return this.authService.createUser(req);
  }

  @Post('login')
  @HttpCode(200)
  async login(
    @Body() dto: LoginDto,
    @Res({ passthrough: true }) response: Response,
  ) {
    const { accessToken, refreshToken, user } = await this.authService.login(dto);

    this.setAuthCookies(response, accessToken, refreshToken);

    return user;
  }

  @Get('me')
  @UseGuards(JwtCookieGuard)
  async me(@Req() request: AuthenticatedRequest) {
    const userId = request.user?.sub;

    if (!userId) {
      throw new UnauthorizedException('Authentication required');
    }

    return this.authService.getMe(userId);
  }

  @Post('refresh')
  @HttpCode(200)
  async refresh(@Res({ passthrough: true }) response: Response) {
    const { accessToken, refreshToken, user } =
      await this.authService.refresh(response.req.cookies?.refresh_token);

    this.setAuthCookies(response, accessToken, refreshToken);
    return user;
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Res({ passthrough: true }) response: Response) {
    await this.authService.logout(response.req.cookies?.refresh_token);
    response.clearCookie('access_token', { httpOnly: true, path: '/' });
    response.clearCookie('refresh_token', { httpOnly: true, path: '/' });
    return;
  }

  private setAuthCookies(
    response: Response,
    accessToken: string,
    refreshToken: string,
  ): void {
    const secure = process.env.NODE_ENV === 'production';

    response.cookie('access_token', accessToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: 15 * 60 * 1000,
      path: '/',
    });

    response.cookie('refresh_token', refreshToken, {
      httpOnly: true,
      secure,
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/api/v1/auth',
    });
  }
}
