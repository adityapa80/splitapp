"use client";

export default function SignOutButton() {
  return (
    <button
      className="btn sm ghost"
      onClick={async () => {
        await fetch("/api/auth/logout", { method: "POST" });
        window.location.assign("/login");
      }}
    >
      Sign out
    </button>
  );
}
