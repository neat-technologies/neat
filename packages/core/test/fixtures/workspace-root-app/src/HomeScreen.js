export function HomeScreen() {
  return fetch(`${process.env.EXPO_PUBLIC_API_URL}/rides`)
}
