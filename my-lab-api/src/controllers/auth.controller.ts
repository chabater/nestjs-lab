import { Controller, Post, Body } from '@nestjs/common';
import { AuthService } from '../services/auth.service';

@Controller('auth')
export class AuthController {
  constructor(private authService: AuthService) {}

  @Post('token')
  async getToken(@Body() body: { username: string; password: string }) {
    return this.authService.login(body.username, body.password);
  }
}
