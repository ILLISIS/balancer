/** Lets promise chains and setImmediate callbacks run to rest. */
export async function settle() {
	for (let i = 0; i < 10; i++) {
		await new Promise(resolve => {
			setImmediate(resolve);
		});
	}
}
