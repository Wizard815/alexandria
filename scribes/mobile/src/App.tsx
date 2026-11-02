import React from 'react';
import { NavigationContainer } from '@react-navigation/native';
import { createNativeStackNavigator } from '@react-navigation/native-stack';
import { LoginScreen } from './screens/LoginScreen';
import { WorldListScreen } from './screens/WorldListScreen';
import { DMScreen } from './screens/DMScreen';
import { PlayerScreen } from './screens/PlayerScreen';

const Stack = createNativeStackNavigator();

export default function App() {
  return (
    <NavigationContainer>
      <Stack.Navigator initialRouteName="Login">
        <Stack.Screen name="Login" component={LoginScreen} options={{ title: 'Connect' }} />
        <Stack.Screen name="WorldList" component={WorldListScreen} options={{ title: 'Select World' }} />
        <Stack.Screen name="DM" component={DMScreen} options={{ title: 'DM Dashboard' }} />
        <Stack.Screen name="Player" component={PlayerScreen} options={{ title: 'Player View' }} />
      </Stack.Navigator>
    </NavigationContainer>
  );
}
