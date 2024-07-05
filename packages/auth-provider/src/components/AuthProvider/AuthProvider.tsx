import {
	AUTH_TYPES,
	JWT,
	pkceChallengePair,
	verifyAndExtractToken,
} from "@versini/auth-common";
import { useLocalStorage } from "@versini/ui-hooks";
import { useCallback, useEffect, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import {
	ACCESS_TOKEN_ERROR,
	EXPIRED_SESSION,
	LOCAL_STORAGE_PREFIX,
	LOGIN_ERROR,
	LOGOUT_SESSION,
} from "../../common/constants";
import type {
	AuthProviderProps,
	AuthState,
	LoginType,
} from "../../common/types";
import {
	TokenManager,
	authenticateUser,
	getPreAuthCode,
	logoutUser,
} from "../../common/utilities";
import { AuthContext } from "./AuthContext";

export const AuthProvider = ({
	children,
	sessionExpiration,
	clientId,
}: AuthProviderProps) => {
	const effectDidRunRef = useRef(false);
	const [idToken, setIdToken, , removeIdToken] = useLocalStorage({
		key: `${LOCAL_STORAGE_PREFIX}::${clientId}::@@user@@`,
	});
	const [accessToken, setAccessToken, , removeAccessToken] = useLocalStorage({
		key: `${LOCAL_STORAGE_PREFIX}::${clientId}::@@access@@`,
	});
	const [refreshToken, setRefreshToken, , removeRefreshToken] = useLocalStorage(
		{
			key: `${LOCAL_STORAGE_PREFIX}::${clientId}::@@refresh@@`,
		},
	);
	const [nonce, setNonce, , removeNonce] = useLocalStorage({
		key: `${LOCAL_STORAGE_PREFIX}::${clientId}::@@nonce@@`,
	});
	const tokenManager = new TokenManager(accessToken, refreshToken);

	const [authState, setAuthState] = useState<AuthState>({
		isLoading: true,
		isAuthenticated: false,
		user: undefined,
		logoutReason: "",
	});

	const removeStateAndLocalStorage = useCallback(
		(logoutReason?: string) => {
			console.warn(logoutReason);
			setAuthState({
				isLoading: true,
				isAuthenticated: false,
				user: undefined,
				logoutReason: logoutReason || EXPIRED_SESSION,
			});
			removeIdToken();
			removeAccessToken();
			removeRefreshToken();
			removeNonce();
		},
		[removeIdToken, removeAccessToken, removeNonce, removeRefreshToken],
	);

	const invalidateAndLogout = useCallback(
		async (message: string) => {
			removeStateAndLocalStorage(message || EXPIRED_SESSION);
			await logoutUser({
				idToken,
				accessToken,
				refreshToken,
				clientId,
			});
			setAuthState((prev) => ({
				...prev,
				isLoading: false,
			}));
		},
		[accessToken, clientId, idToken, removeStateAndLocalStorage, refreshToken],
	);

	/**
	 * This effect is responsible to set the authentication state based on the
	 * idToken stored in the local storage. It is used when the page is being
	 * first loaded or refreshed.
	 */
	useEffect(() => {
		if (effectDidRunRef.current) {
			return;
		}
		if (authState.isLoading && idToken !== null) {
			(async () => {
				try {
					const jwt = await verifyAndExtractToken(idToken);
					if (jwt && jwt.payload[JWT.USER_ID_KEY] !== "") {
						setAuthState({
							isLoading: false,
							isAuthenticated: true,
							user: {
								userId: jwt.payload[JWT.USER_ID_KEY] as string,
								username: jwt.payload[JWT.USERNAME_KEY] as string,
							},
							logoutReason: "",
						});
					} else {
						await invalidateAndLogout(EXPIRED_SESSION);
					}
				} catch (_error) {
					await invalidateAndLogout(EXPIRED_SESSION);
				}
			})();
		} else {
			setAuthState((prev) => ({
				...prev,
				isLoading: false,
			}));
		}
		return () => {
			effectDidRunRef.current = true;
		};
	}, [authState.isLoading, idToken, invalidateAndLogout]);

	const login: LoginType = async (username, password, type) => {
		const _nonce = uuidv4();
		setNonce(_nonce);
		setAuthState((prev) => ({
			...prev,
			isLoading: true,
		}));

		if (type === AUTH_TYPES.CODE) {
			const { code_verifier, code_challenge } = await pkceChallengePair();

			const preResponse = await getPreAuthCode({
				nonce: _nonce,
				clientId,
				code_challenge,
			});
			if (preResponse.status) {
				// we received the auth code, now we need to exchange it for the tokens
				const response = await authenticateUser({
					username,
					password,
					clientId,
					sessionExpiration,
					nonce: _nonce,
					type,
					code: preResponse.code,
					code_verifier,
				});
				if (response.status) {
					setIdToken(response.idToken);
					setAccessToken(response.accessToken);
					setRefreshToken(response.refreshToken);
					setAuthState({
						isLoading: false,
						isAuthenticated: true,
						user: {
							userId: response.userId,
							username,
						},
						logoutReason: "",
					});
					return true;
				}
				removeStateAndLocalStorage(LOGIN_ERROR);
				return false;
			}
			return false;
		}

		const response = await authenticateUser({
			username,
			password,
			clientId,
			sessionExpiration,
			nonce: _nonce,
			type,
		});
		if (response.status) {
			setIdToken(response.idToken);
			setAccessToken(response.accessToken);
			setRefreshToken(response.refreshToken);
			setAuthState({
				isLoading: false,
				isAuthenticated: true,
				user: {
					userId: response.userId,
					username,
				},
			});
			return true;
		}
		removeStateAndLocalStorage(LOGIN_ERROR);
		return false;
	};

	const logout = async (e: any) => {
		e?.preventDefault();
		await invalidateAndLogout(LOGOUT_SESSION);
	};

	const getAccessToken = async () => {
		const { isAuthenticated, user } = authState;
		try {
			if (isAuthenticated && user && user.userId) {
				if (accessToken) {
					const jwtAccess = await verifyAndExtractToken(accessToken);
					if (jwtAccess && jwtAccess.payload[JWT.USER_ID_KEY] !== "") {
						return accessToken;
					}
				}
				/**
				 * accessToken is not valid, so we need to try to refresh it using the
				 * refreshToken - this is a silent refresh.
				 */
				const res = await tokenManager.refreshtoken({
					clientId,
					userId: user.userId as string,
					nonce,
				});
				if (res.status && res.status === "success") {
					setAccessToken(res.newAccessToken);
					setRefreshToken(res.newRefreshToken);
					return res.newAccessToken;
				}
				/**
				 * refreshToken is not valid, so we need to re-authenticate the user.
				 */
				await invalidateAndLogout(ACCESS_TOKEN_ERROR);
				return "";
			}
			await invalidateAndLogout(ACCESS_TOKEN_ERROR);
			return "";
		} catch (_error) {
			await invalidateAndLogout(ACCESS_TOKEN_ERROR);
			return "";
		}
	};

	const getIdToken = () => {
		if (authState.isAuthenticated && idToken) {
			return idToken;
		}
	};

	return (
		<AuthContext.Provider
			value={{ ...authState, login, logout, getAccessToken, getIdToken }}
		>
			{children}
		</AuthContext.Provider>
	);
};
