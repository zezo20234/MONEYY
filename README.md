# Money Manager App

A beautiful personal money manager app designed for mobile and desktop, with PWA support for installation on your home screen.

## Features

- 🔐 **User Authentication**: Simple username/password accounts stored in Firebase Realtime Database
- 👥 **Multiple Users**: Each user has completely separate data and accounts
- ⚙️ **Customizable Settings**: Set your own Hangout limit, enable/disable buckets, customize allowance splits
- 🎯 **Account Setup**: Personalized onboarding when creating a new account
- 💰 **Allowance Management**: Add allowance with auto-calculated splits (customizable percentages)
- 🔄 **Flexible Transfers**: Move money between buckets anytime
- 🛒 **Purchase Tracking**: Record purchases from any bucket
- ✏️ **Manual Editing**: Fix balances when needed
- 🗑️ **Transaction Management**: Edit or delete any transaction from history
- 🎯 **Goals**: Set and track savings goals
- 📊 **Charts**: Visual spending breakdown and allowance history
- 📱 **PWA**: Install on home screen like a real app
- ☁️ **Firebase**: Real-time sync across devices with per-user data isolation
- 🎨 **Premium Design**: Beautiful liquid-glass UI with smooth animations

## Money Rules

- **Hangout**: Maximum 140 SAR (excess automatically moves to Savings)
- **Savings**: Flexible, carries over indefinitely
- **PlayStation/Mobily**: For gaming and mobile expenses
- No monthly resets - money carries over forever
- Custom allowance amounts supported
- Auto-calculation: Allowance splits automatically (50% Hangout, 37.5% Savings, 12.5% PlayStation)

## Quick Start

1. Open `index.html` in your browser
2. Click "Sign Up" to create an account with username and password
3. Login with your credentials
4. Set your initial balances using "Edit Money"
5. Start tracking your finances!

Icons are already included for PWA installation.

## Firebase Configuration

The app uses Firebase Realtime Database with the following configuration:

- Project: money-e560a
- Database: Realtime Database
- Authentication: Custom username/password system stored in database
- Features: Balances, History, Goals storage (per-user)

**No additional Firebase setup required!** The app handles authentication directly in the Realtime Database.

**Data Privacy**: Each user's data is completely private and isolated under their username. Users can only see and modify their own financial data.

## File Structure

```
MONEY/
├── index.html              # Main app (contains everything)
├── manifest.json           # PWA manifest
├── service-worker.js       # PWA service worker
├── icon-192.png           # 192x192 app icon
├── icon-512.png           # 512x512 app icon
└── README.md              # This file
```

## Usage Tips

- **Add Allowance**: Use "I Got Allowance" to add money - splits auto-calculate (50% Hangout, 37.5% Savings, 12.5% PlayStation)
- **Custom Splits**: Adjust the sliders if you want different percentages
- **Hangout Limit**: The app automatically moves excess above 140 SAR to Savings
- **Goals**: Set savings goals to track progress toward big purchases
- **Edit Transactions**: Hover over any transaction in the activity feed to see edit/delete buttons
- **Delete Transactions**: Remove mistakes by clicking the trash icon on any transaction
- **Transaction History**: All changes are logged and can be modified if needed

## Mobile Installation (iOS)

1. Open the app in Safari
2. Tap "Share" and select "Add to Home Screen"
3. The app will install like a native app

## Mobile Installation (Android)

1. Open the app in Chrome
2. Tap the menu and select "Install App" or "Add to Home Screen"

## Technical Details

- **Framework**: Vanilla JavaScript (no dependencies except Firebase)
- **Charts**: Chart.js via CDN
- **Database**: Firebase Realtime Database
- **Styling**: Premium liquid-glass design with backdrop-filter, blur effects, and smooth animations
- **Responsive**: Mobile-first design, works on all screen sizes
- **PWA**: Full Progressive Web App support with service worker caching

## Privacy

- All data stored in your personal Firebase database
- No third-party analytics or tracking
- Works offline after first load (PWA caching)

---

Made with 💜 for personal finance management
