# FIREBASE RULES — ISI TERMINAL v6

## Realtime Database Rules
Go to: Firebase Console → Realtime Database → Rules

```json
{
  "rules": {
    ".read": true,
    ".write": true
  }
}
```

## Storage Rules
Go to: Firebase Console → Storage → Rules

```
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /{allPaths=**} {
      allow read, write: if true;
    }
  }
}
```

## NOTE
These are open rules for development.
For production, add authentication rules.
