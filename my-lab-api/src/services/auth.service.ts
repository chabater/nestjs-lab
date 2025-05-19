import { Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

@Injectable()
export class AuthService {
  // constructor(private jwtService: JwtService) {}

  // private validUsers = {
  //   admin: 'password123', // 硬編碼帳號密碼，可替換為資料庫驗證
  // };
  private validUsers;

  constructor(private jwtService: JwtService) {
    this.validUsers = this.loadUsersFromEnv();
  }

  private loadUsersFromEnv(): Record<string, string> {
    const envUsers = process.env.AUTH_USERS || '';
    const userPairs = envUsers.split(','); // 多組以逗號分隔
    const users: Record<string, string> = {};
    for (const pair of userPairs) {
      const [username, password] = pair.split(':');
      if (username && password) {
        users[username] = password;
      }
    }
    return users;
  }

  async validateUser(username: string, password: string): Promise<any> {
    if (this.validUsers[username] && this.validUsers[username] === password) {
      return { username };
    }
    return null;
  }

  async login(username: string, password: string) {
    const user = await this.validateUser(username, password);
    if (!user) throw new UnauthorizedException();

    const payload = { username: user.username, sub: Date.now() };
    return {
      access_token: this.jwtService.sign(payload),
    };
  }
}
