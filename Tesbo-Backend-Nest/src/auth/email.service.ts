import { Injectable } from "@nestjs/common";
import { AppConfigService } from "../config/app-config.service";

@Injectable()
export class EmailService {
  constructor(private readonly config: AppConfigService) {}

  async sendOtp(to: string, code: string): Promise<void> {
    if (!this.config.postmarkApiToken) {
      console.log(`OTP for ${to}: ${code}`);
      return;
    }
    const response = await fetch("https://api.postmarkapp.com/email", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Postmark-Server-Token": this.config.postmarkApiToken
      },
      body: JSON.stringify({
        From: this.config.postmarkFromEmail,
        To: to,
        Subject: "Your Tesbo verification code",
        TextBody: `Your Tesbo verification code is ${code}. It expires in ${this.config.otpExpiryMinutes} minutes.`
      })
    });
    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Postmark returned ${response.status}: ${body}`);
    }
  }
}
