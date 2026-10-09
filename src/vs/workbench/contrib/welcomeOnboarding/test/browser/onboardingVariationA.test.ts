/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import sinon from 'sinon';
import { $ } from '../../../../../base/browser/dom.js';
import { mainWindow } from '../../../../../base/browser/window.js';
import { DeferredPromise } from '../../../../../base/common/async.js';
import { toDisposable } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ICommandService } from '../../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import { IDefaultAccountService } from '../../../../../platform/defaultAccount/common/defaultAccount.js';
import { IExtensionGalleryService, IExtensionManagementService } from '../../../../../platform/extensionManagement/common/extensionManagement.js';
import { ILayoutService } from '../../../../../platform/layout/browser/layoutService.js';
import { ColorThemeData } from '../../../../services/themes/common/colorThemeData.js';
import { IWorkbenchThemeService } from '../../../../services/themes/common/workbenchThemeService.js';
import { workbenchInstantiationService } from '../../../../test/browser/workbenchTestServices.js';
import { OnboardingVariationA } from '../../browser/onboardingVariationA.js';

suite('OnboardingVariationA', () => {
	const store = ensureNoDisposablesAreLeakedInTestSuite();
	teardown(() => sinon.restore());

	function createOnboarding(configuration = new TestConfigurationService()) {
		const container = mainWindow.document.body.appendChild($('div'));
		store.add(toDisposable(() => container.remove()));
		store.add(configuration.onDidChangeConfigurationEmitter);
		const instantiationService = workbenchInstantiationService(undefined, store);
		instantiationService.stub(ILayoutService, { activeContainer: container });
		instantiationService.stub(IWorkbenchThemeService, { getColorTheme: () => ColorThemeData.createLoadedEmptyTheme('test', '') });
		instantiationService.stub(IExtensionGalleryService, {});
		instantiationService.stub(IExtensionManagementService, {});
		instantiationService.stub(IDefaultAccountService, { resolveGitHubUrl: () => undefined });
		instantiationService.stub(IConfigurationService, configuration);
		const commandInvoked = new DeferredPromise<void>();
		const executeCommand = sinon.stub().callsFake(async () => {
			await commandInvoked.complete();
			return false;
		});
		instantiationService.stub(ICommandService, { executeCommand });
		const onboarding = store.add(instantiationService.createInstance(OnboardingVariationA));
		onboarding.show();
		return { container, executeCommand, commandInvoked: commandInvoked.p };
	}

	test('disclaimer ends with the public code sentence and offers no settings link', () => {
		const { container } = createOnboarding();

		const disclaimer = container.querySelector('.onboarding-a-signin-disclaimer');
		assert.ok(disclaimer);
		const settingsLinks = Array.from(disclaimer.querySelectorAll('a, [tabindex]'))
			.filter(element => element.textContent === 'settings');
		assert.deepStrictEqual({
			coherentText: disclaimer.textContent?.endsWith('suggestions and use your data to improve the product.'),
			settingsLinks: settingsLinks.length,
		}, {
			coherentText: true,
			settingsLinks: 0,
		});
	});

});
